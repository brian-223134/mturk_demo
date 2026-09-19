// Api 인터페이스의 mock 구현. 브라우저 mock 모드와 mock API 서버(server/)가 이 파일을 함께 쓴다.
// 계산은 src/domain의 순수 함수에 맡기고, 여기서는 검증, 상태 변경, MTurk 동작의 흉내만 한다.

import { agreementWithOthers, collectItems, summarizeResults, type Vote } from '../../domain/agreement';
import { DEFAULT_ATTENTION_PREFIX, isAttentionName } from '../../domain/attention';
import {
  batchCost,
  estimateCost,
  feeCentsPerAssignment,
  feePercent,
  formatCents,
  rewardToCents,
  usesMasters,
} from '../../domain/cost';
import { buildLabelsJson, buildMturkCsv } from '../../domain/exportFormats';
import {
  batchStatus,
  countByStatus,
  hitProgress,
  isExpired,
  planTopUp,
  summarizeProgress,
} from '../../domain/progress';
import { extractPlaceholders } from '../../domain/template';
import { computeWorkerStats, type WorkerStatsRecord } from '../../domain/workerStats';
import type { Api } from '../client';
import {
  ApiError,
  type Assignment,
  type AssignmentListItem,
  type Batch,
  type BatchDetail,
  type BatchSummary,
  type Hit,
  type HitListItem,
  type Worker,
  type WorkerDetail,
  type WorkerStats,
} from '../types';
import { applyListQuery } from './listQuery';
import type { MockStore, StoreState } from './store';

export interface MockApiOptions {
  /** 모든 호출에 넣는 지연의 [최소, 최대] ms. 로딩 상태가 화면에 드러나게 한다 (7.2). */
  delayMs?: [number, number];
  now?: () => Date;
  random?: () => number;
}

export const REJECTION_OVERRIDE_DAYS = 30; // MTurk: 반려 번복은 30일 이내
const INPUT_PREVIEW_CHARS = 200;
const DAY_MS = 24 * 60 * 60 * 1000;

const EMPTY_STATS: WorkerStats = {
  total: 0,
  approved: 0,
  rejected: 0,
  pending: 0,
  rejectRate: null,
  attentionFailRate: null,
  medianWorkTimeInSeconds: null,
  majorityAgreement: null,
  batchCount: 0,
  lastActiveAt: null,
};

export function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = groups.get(k);
    if (list) list.push(item);
    else groups.set(k, [item]);
  }
  return groups;
}

function invalid(message: string): never {
  throw new ApiError('INVALID_REQUEST', message);
}

// HTTP로는 어떤 값이든 올 수 있다. 형태가 틀리면 TypeError로 500을 내지 않고 400으로 알린다.
function stringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) invalid(`"${name}" must be an array of strings.`);
  return value as string[];
}

function objectBody<T>(value: T, name: string): T {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid(`"${name}" must be a JSON object.`);
  return value;
}

function notFound(what: string, id: string): never {
  throw new ApiError('NOT_FOUND', `${what} not found: ${id}`);
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** MTurk의 HITId, AssignmentId처럼 보이는 30자 ID */
export function mturkLikeId(random: () => number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let id = '3';
  for (let i = 0; i < 29; i += 1) id += chars[Math.floor(random() * chars.length)];
  return id;
}

export function attentionPrefixOf(batch: Batch | undefined): string {
  return batch?.attentionRule?.namePrefix ?? DEFAULT_ATTENTION_PREFIX;
}

/** assignment 수에 맞춰 HIT의 MTurk 필드를 다시 맞춘다. */
export function syncHit(hit: Hit, assignments: readonly Assignment[], now: Date): void {
  const counts = countByStatus(assignments);
  hit.NumberOfAssignmentsPending = 0;
  hit.NumberOfAssignmentsCompleted = counts.approved + counts.rejected;
  hit.NumberOfAssignmentsAvailable = Math.max(0, hit.MaxAssignments - assignments.length);
  hit.HITStatus = isExpired(hit, now) || hit.NumberOfAssignmentsAvailable === 0 ? 'Reviewable' : 'Assignable';
}

/** assignment 1건의 값 (reward + 수수료). HIT의 MaxAssignments에 따라 수수료율이 달라진다 (8.1). */
export function unitCostCents(batch: Batch, hit: Pick<Hit, 'MaxAssignments'>): number {
  const reward = rewardToCents(batch.settings.Reward);
  const percent = feePercent(hit.MaxAssignments, usesMasters(batch.settings.QualificationRequirements));
  return reward + feeCentsPerAssignment(reward, percent);
}

function balanceCents(state: StoreState): number {
  return Math.round(Number.parseFloat(state.account.AvailableBalance) * 100);
}

/** MTurk는 HIT를 만들 때 비용을 미리 잡아 두고, 반려하면 돌려준다. 잔액이 모자라면 상태를 바꾸기 전에 막는다. */
function ensureBalance(state: StoreState, neededCents: number): void {
  if (neededCents > balanceCents(state)) {
    invalid(
      `Insufficient balance: this needs ${formatCents(neededCents)} but only $${state.account.AvailableBalance} is available.`,
    );
  }
}

function adjustBalance(state: StoreState, deltaCents: number): void {
  state.account.AvailableBalance = ((balanceCents(state) + deltaCents) / 100).toFixed(2);
}

function summarizeBatch(
  batch: Batch,
  state: StoreState,
  assignmentsByHit: Map<string, Assignment[]>,
  now: Date,
): BatchDetail {
  const hits = state.hits.filter((h) => h.batchId === batch.id);
  const target = batch.settings.MaxAssignments;
  const perHit = hits.map((hit) => ({
    hit,
    progress: hitProgress(hit, countByStatus(assignmentsByHit.get(hit.HITId) ?? []), target),
  }));
  const progress = summarizeProgress(perHit.map((h) => h.progress));
  return {
    batch,
    status: batchStatus(
      perHit.map(({ hit, progress: p }) => ({ completed: p.completed, expired: isExpired(hit, now) })),
    ),
    needsReview: progress.submitted > 0,
    progress,
    cost: batchCost(
      perHit.map(({ hit, progress: p }) => ({
        MaxAssignments: hit.MaxAssignments,
        approved: p.approved,
        rejected: p.rejected,
      })),
      batch.settings.Reward,
      usesMasters(batch.settings.QualificationRequirements),
    ),
  };
}

function buildWorkers(state: StoreState): Worker[] {
  const hitById = new Map(state.hits.map((h) => [h.HITId, h]));
  const batchById = new Map(state.batches.map((b) => [b.id, b]));

  const records: WorkerStatsRecord[] = [];
  for (const assignment of state.assignments) {
    const hit = hitById.get(assignment.HITId);
    if (!hit) continue;
    records.push({
      assignment,
      batchId: hit.batchId,
      rowIndex: hit.rowIndex,
      attentionPrefix: attentionPrefixOf(batchById.get(hit.batchId)),
    });
  }
  const stats = computeWorkerStats(records);

  // 응답이 없어도 pool에 들어 있거나 메모가 붙은 worker는 목록에 나온다
  const ids = new Set<string>(stats.keys());
  for (const pool of state.pools) for (const id of pool.workerIds) ids.add(id);
  for (const id of Object.keys(state.workerMeta)) ids.add(id);

  return [...ids].map((WorkerId) => ({
    WorkerId,
    stats: stats.get(WorkerId) ?? EMPTY_STATS,
    poolIds: state.pools.filter((p) => p.workerIds.includes(WorkerId)).map((p) => p.id),
    blocked: state.workerMeta[WorkerId]?.blocked ?? false,
    note: state.workerMeta[WorkerId]?.note ?? '',
  }));
}

/** 통계 값이 없는(null) worker는 조건을 만족하지 않는 것으로 본다. "조건으로 채우기"가 보수적으로 동작한다. */
function threshold(pick: (w: Worker) => number | null, test: (actual: number, limit: number) => boolean) {
  return (worker: Worker, value: unknown) => {
    const actual = pick(worker);
    return actual !== null && test(actual, Number(value));
  };
}

export function createMockApi(store: MockStore, options: MockApiOptions = {}): Api {
  const [minDelay, maxDelay] = options.delayMs ?? [200, 500];
  const now = options.now ?? (() => new Date());
  const random = options.random ?? Math.random;

  const delay = () =>
    new Promise<void>((resolve) => setTimeout(resolve, minDelay + Math.random() * (maxDelay - minDelay)));

  /** 지연을 넣고 상태를 읽는다. 결과는 복제해서 돌려준다 (화면이 저장소의 객체를 직접 쥐지 않게). */
  async function read<T>(handler: (state: StoreState) => T): Promise<T> {
    await delay();
    return structuredClone(handler(await store.getState()));
  }

  /**
   * 상태를 바꾼다. handler는 검증을 전부 마친 뒤에 상태를 고쳐야 한다. 도중에 오류를 던지면
   * 앞서 고친 내용이 남기 때문이다.
   */
  async function write<T>(handler: (state: StoreState) => T): Promise<T> {
    await delay();
    let result!: T;
    await store.update((state) => {
      result = handler(state);
    });
    return structuredClone(result);
  }

  function findBatch(state: StoreState, id: string): Batch {
    return state.batches.find((b) => b.id === id) ?? notFound('Batch', id);
  }

  function batchOfHit(state: StoreState, hit: Hit): Batch {
    return findBatch(state, hit.batchId);
  }

  // worker 집계는 모든 assignment를 훑으므로 상태가 바뀔 때만 다시 계산한다
  let workerCache: { revision: number; workers: Worker[] } | null = null;
  function workersOf(state: StoreState): Worker[] {
    if (workerCache?.revision !== store.revision) {
      workerCache = { revision: store.revision, workers: buildWorkers(state) };
    }
    return workerCache.workers;
  }

  function findAssignments(state: StoreState, ids: string[]): Assignment[] {
    stringArray(ids, 'ids');
    if (ids.length === 0) invalid('No assignments selected.');
    const byId = new Map(state.assignments.map((a) => [a.AssignmentId, a]));
    return ids.map((id) => byId.get(id) ?? notFound('Assignment', id));
  }

  function resyncHits(state: StoreState, hitIds: Iterable<string>): void {
    const byHit = groupBy(state.assignments, (a) => a.HITId);
    const wanted = new Set(hitIds);
    for (const hit of state.hits) {
      if (wanted.has(hit.HITId)) syncHit(hit, byHit.get(hit.HITId) ?? [], now());
    }
  }

  function approvedVotes(state: StoreState, batch: Batch): Vote[] {
    const hitById = new Map(state.hits.filter((h) => h.batchId === batch.id).map((h) => [h.HITId, h]));
    const prefix = attentionPrefixOf(batch);
    const votes: Vote[] = [];
    for (const a of state.assignments) {
      const hit = hitById.get(a.HITId);
      if (!hit || a.AssignmentStatus !== 'Approved') continue;
      for (const answer of a.answers) {
        if (isAttentionName(answer.name, prefix)) continue;
        votes.push({ rowIndex: hit.rowIndex, answerName: answer.name, value: answer.value, workerId: a.WorkerId });
      }
    }
    return votes;
  }

  function findPool(state: StoreState, id: string) {
    return state.pools.find((p) => p.id === id) ?? notFound('Pool', id);
  }

  function metaOf(state: StoreState, workerId: string) {
    return (state.workerMeta[workerId] ??= { blocked: false, note: '' });
  }

  return {
    // ── Templates ──────────────────────────────────────────────────────────
    listTemplates: () =>
      read((state) => [...state.templates].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))),

    getTemplate: (id) => read((state) => state.templates.find((t) => t.id === id) ?? notFound('Template', id)),

    saveTemplate: (req) =>
      write((state) => {
        objectBody(req, 'template');
        if (typeof req.name !== 'string' || typeof req.html !== 'string') invalid('"name" and "html" must be strings.');
        const name = req.name.trim();
        if (!name) invalid('Template name is required.');
        if (!req.html?.trim()) invalid('Template HTML is empty.');
        const fields = {
          name,
          html: req.html,
          placeholders: extractPlaceholders(req.html),
          updatedAt: now().toISOString(),
        };
        if (req.id) {
          const existing = state.templates.find((t) => t.id === req.id) ?? notFound('Template', req.id);
          Object.assign(existing, fields);
          return existing;
        }
        let id = `tpl-${slug(name) || 'template'}`;
        for (let n = 2; state.templates.some((t) => t.id === id); n += 1) id = `tpl-${slug(name) || 'template'}-${n}`;
        const created = { id, ...fields };
        state.templates.push(created);
        return created;
      }),

    deleteTemplate: (id) =>
      write((state) => {
        const index = state.templates.findIndex((t) => t.id === id);
        if (index < 0) notFound('Template', id);
        // 게시된 batch는 templateHtml 사본을 갖고 있으므로 영향받지 않는다
        state.templates.splice(index, 1);
      }),

    // ── Batches ────────────────────────────────────────────────────────────
    listBatches: () =>
      read((state): BatchSummary[] => {
        const byHit = groupBy(state.assignments, (a) => a.HITId);
        return state.batches
          .map((batch) => {
            const { batch: full, ...rest } = summarizeBatch(batch, state, byHit, now());
            const { templateHtml: _omitted, ...light } = full;
            return { batch: light, ...rest };
          })
          .sort((a, b) => b.batch.createdAt.localeCompare(a.batch.createdAt));
      }),

    getBatch: (id) =>
      read((state) =>
        summarizeBatch(findBatch(state, id), state, groupBy(state.assignments, (a) => a.HITId), now()),
      ),

    createBatch: (req) =>
      write((state) => {
        objectBody(req, 'batch');
        objectBody(req.settings, 'settings');
        stringArray(req.inputColumns, 'inputColumns');
        stringArray(req.requiredPoolIds, 'requiredPoolIds');
        stringArray(req.excludedPoolIds, 'excludedPoolIds');
        stringArray(req.settings.QualificationRequirements?.map((r) => r?.QualificationTypeId), 'QualificationRequirements[].QualificationTypeId');
        const name = typeof req.name === 'string' ? req.name.trim() : '';
        if (!name) invalid('Batch name is required.');
        const template = state.templates.find((t) => t.id === req.templateId) ?? notFound('Template', req.templateId);
        if (!Array.isArray(req.rows) || req.rows.length === 0) invalid('The CSV has no rows.');
        if (req.rows.some((row) => typeof row !== 'object' || row === null)) invalid('"rows" must be an array of objects.');

        const missing = template.placeholders.filter((p) => !req.inputColumns.includes(p));
        if (missing.length > 0) {
          invalid(`The CSV is missing columns used by the template: ${missing.map((m) => `\${${m}}`).join(', ')}`);
        }
        const s = req.settings;
        if (!s.Title?.trim()) invalid('Title is required.');
        if (!Number.isInteger(s.MaxAssignments) || s.MaxAssignments < 1) invalid('MaxAssignments must be an integer ≥ 1.');
        for (const field of ['AssignmentDurationInSeconds', 'LifetimeInSeconds', 'AutoApprovalDelayInSeconds'] as const) {
          if (!Number.isFinite(s[field]) || s[field] <= 0) invalid(`${field} must be greater than 0.`);
        }
        if (s.AutoApprovalDelayInSeconds > 30 * 24 * 3600) invalid('AutoApprovalDelayInSeconds cannot exceed 30 days.');
        let rewardCents: number;
        try {
          rewardCents = rewardToCents(s.Reward);
        } catch {
          invalid(`Reward is not a valid amount: ${JSON.stringify(s.Reward)}`);
        }
        if (rewardCents < 1) invalid('Reward must be at least $0.01.');
        for (const poolId of [...req.requiredPoolIds, ...req.excludedPoolIds]) findPool(state, poolId);

        const estimate = estimateCost({
          hitCount: req.rows.length,
          maxAssignments: s.MaxAssignments,
          reward: s.Reward,
          masters: usesMasters(s.QualificationRequirements),
        });
        ensureBalance(state, estimate.totalCents);

        // 검증 끝. 여기부터 상태를 바꾼다.
        const createdAt = now();
        let id = `batch-${String(Math.floor(random() * 9_000_000) + 1_000_000)}`;
        while (state.batches.some((b) => b.id === id)) id = `batch-${String(Math.floor(random() * 9_000_000) + 1_000_000)}`;
        const batch: Batch = {
          id,
          name,
          env: state.account.env,
          templateId: template.id,
          templateHtml: template.html,
          inputColumns: [...req.inputColumns],
          settings: { ...s, Reward: (rewardCents / 100).toFixed(2) },
          attentionRule: req.attentionRule,
          requiredPoolIds: [...req.requiredPoolIds],
          excludedPoolIds: [...req.excludedPoolIds],
          createdAt: createdAt.toISOString(),
          ...(req.answerSchema?.length ? { answerSchema: req.answerSchema } : {}),
        };
        const expiration = new Date(createdAt.getTime() + s.LifetimeInSeconds * 1000).toISOString();
        req.rows.forEach((row, rowIndex) => {
          state.hits.push({
            HITId: mturkLikeId(random),
            HITStatus: 'Assignable',
            MaxAssignments: s.MaxAssignments,
            NumberOfAssignmentsPending: 0,
            NumberOfAssignmentsAvailable: s.MaxAssignments,
            NumberOfAssignmentsCompleted: 0,
            CreationTime: createdAt.toISOString(),
            Expiration: expiration,
            batchId: id,
            rowIndex,
            input: Object.fromEntries(req.inputColumns.map((c) => [c, row[c] ?? ''])),
            initialMaxAssignments: s.MaxAssignments,
          });
        });
        state.batches.push(batch);
        adjustBalance(state, -estimate.totalCents);
        return batch;
      }),

    expireBatch: (id) =>
      write((state) => {
        findBatch(state, id);
        const at = now();
        const byHit = groupBy(state.assignments, (a) => a.HITId);
        for (const hit of state.hits) {
          if (hit.batchId !== id) continue;
          if (!isExpired(hit, at)) hit.Expiration = at.toISOString();
          syncHit(hit, byHit.get(hit.HITId) ?? [], at);
        }
      }),

    // ── HITs and assignments ───────────────────────────────────────────────
    listHits: (batchId, q) =>
      read((state) => {
        const batch = findBatch(state, batchId);
        const byHit = groupBy(state.assignments, (a) => a.HITId);
        const at = now();
        const items = state.hits
          .filter((h) => h.batchId === batchId)
          .map(({ input, ...hit }): HitListItem => ({
            ...hit,
            inputPreview: Object.fromEntries(
              Object.entries(input).map(([column, cell]) => [
                column,
                cell.length > INPUT_PREVIEW_CHARS ? `${cell.slice(0, INPUT_PREVIEW_CHARS)}…` : cell,
              ]),
            ),
            progress: hitProgress(hit, countByStatus(byHit.get(hit.HITId) ?? []), batch.settings.MaxAssignments),
            expired: isExpired(hit, at),
          }));
        return applyListQuery(items, q, {
          customFilters: { incomplete: (hit, value) => !value || !hit.progress.completed },
        });
      }),

    getHit: (hitId) => read((state) => state.hits.find((h) => h.HITId === hitId) ?? notFound('HIT', hitId)),

    listAssignments: (batchId, q) =>
      read((state) => {
        const batch = findBatch(state, batchId);
        const prefix = attentionPrefixOf(batch);
        const hitById = new Map(state.hits.filter((h) => h.batchId === batchId).map((h) => [h.HITId, h]));
        const inBatch = state.assignments.filter((a) => hitById.has(a.HITId));
        const byHit = groupBy(inBatch, (a) => a.HITId);
        const real = (a: Assignment) => a.answers.filter((x) => !isAttentionName(x.name, prefix));

        const items = inBatch.map((a): AssignmentListItem => ({
          ...a,
          rowIndex: hitById.get(a.HITId)!.rowIndex,
          // 비교 기준에는 반려된 응답을 넣지 않는다 (workerStats와 같은 기준)
          agreement: agreementWithOthers(
            real(a),
            (byHit.get(a.HITId) ?? [])
              .filter((other) => other.AssignmentId !== a.AssignmentId && other.AssignmentStatus !== 'Rejected')
              .map(real),
          ),
        }));
        return applyListQuery(items, q, {
          customFilters: {
            attention: (a, value) =>
              value === 'pass' ? a.attention?.passed === true
              : value === 'fail' ? a.attention?.passed === false
              : a.attention === null,
            maxWorkTime: (a, value) => a.workTimeInSeconds < Number(value),
            workerSearch: (a, value) => a.WorkerId.toLowerCase().includes(String(value).toLowerCase()),
          },
        });
      }),

    approveAssignments: (ids, feedback, override) =>
      write((state) => {
        const targets = findAssignments(state, ids);
        const hitById = new Map(state.hits.map((h) => [h.HITId, h]));
        const at = now();
        let reapprovalCents = 0;
        for (const a of targets) {
          if (a.AssignmentStatus === 'Approved') invalid(`Assignment ${a.AssignmentId} is already approved.`);
          if (a.AssignmentStatus === 'Rejected') {
            if (!override) invalid(`Assignment ${a.AssignmentId} was rejected. Use "Revert to approved" to override.`);
            const rejectedAt = new Date(a.RejectionTime ?? a.SubmitTime).getTime();
            if (at.getTime() - rejectedAt > REJECTION_OVERRIDE_DAYS * DAY_MS) {
              invalid(
                `Assignment ${a.AssignmentId} was rejected more than ${REJECTION_OVERRIDE_DAYS} days ago. MTurk no longer allows overriding it.`,
              );
            }
            const hit = hitById.get(a.HITId)!;
            reapprovalCents += unitCostCents(batchOfHit(state, hit), hit);
          }
        }
        ensureBalance(state, reapprovalCents); // 반려할 때 돌려받은 금액을 다시 낸다

        for (const a of targets) {
          a.AssignmentStatus = 'Approved';
          a.ApprovalTime = at.toISOString();
          delete a.RejectionTime;
          if (typeof feedback === 'string' && feedback.trim()) a.RequesterFeedback = feedback.trim();
          else delete a.RequesterFeedback;
        }
        adjustBalance(state, -reapprovalCents);
        resyncHits(state, targets.map((a) => a.HITId));
        return targets;
      }),

    rejectAssignments: (ids, feedback) =>
      write((state) => {
        const reason = typeof feedback === 'string' ? feedback.trim() : '';
        if (!reason) invalid('Feedback is required when rejecting. Workers see it as the reason.');
        const targets = findAssignments(state, ids);
        const hitById = new Map(state.hits.map((h) => [h.HITId, h]));
        for (const a of targets) {
          if (a.AssignmentStatus !== 'Submitted') {
            invalid(`Assignment ${a.AssignmentId} is ${a.AssignmentStatus}. Only submitted assignments can be rejected.`);
          }
        }
        const at = now();
        let refundCents = 0;
        for (const a of targets) {
          a.AssignmentStatus = 'Rejected';
          a.RejectionTime = at.toISOString();
          a.RequesterFeedback = reason;
          const hit = hitById.get(a.HITId)!;
          refundCents += unitCostCents(batchOfHit(state, hit), hit);
        }
        adjustBalance(state, refundCents);
        resyncHits(state, targets.map((a) => a.HITId));
        return targets;
      }),

    addAssignments: (hitIds, mode) =>
      write((state) => {
        stringArray(hitIds, 'hitIds');
        if (hitIds.length === 0) invalid('No HITs selected.');
        if (mode !== 'fill-to-target' && (!Number.isInteger(mode) || mode < 1)) {
          invalid('The number of assignments to add must be an integer ≥ 1.');
        }
        const hitById = new Map(state.hits.map((h) => [h.HITId, h]));
        const byHit = groupBy(state.assignments, (a) => a.HITId);
        const at = now();

        const plans = hitIds.map((hitId) => {
          const hit = hitById.get(hitId) ?? notFound('HIT', hitId);
          const batch = batchOfHit(state, hit);
          const progress = hitProgress(hit, countByStatus(byHit.get(hitId) ?? []), batch.settings.MaxAssignments);
          const plan = planTopUp(hit, progress, mode);
          // 부족분은 없지만 만료되어 막힌 HIT: 남은 자리가 worker에게 보이지 않아 영영 완료되지 않는다.
          // "미완료 HIT 재모집"의 목적은 다시 완료될 수 있게 하는 것이므로 게시 기간만 연장한다.
          const reopenOnly =
            mode === 'fill-to-target' && plan.add === 0 && isExpired(hit, at) && !progress.completed && progress.open > 0;
          return { hit, batch, plan, reopenOnly };
        });
        ensureBalance(
          state,
          plans.reduce((sum, { hit, batch, plan }) => sum + plan.add * unitCostCents(batch, hit), 0),
        );

        const result = { added: [], skipped: [] } as {
          added: { HITId: string; count: number; expirationExtended: boolean }[];
          skipped: { HITId: string; reason: string }[];
        };
        for (const { hit, batch, plan, reopenOnly } of plans) {
          if (plan.add === 0 && !reopenOnly) {
            result.skipped.push({ HITId: hit.HITId, reason: plan.reason ?? 'Nothing to add.' });
            continue;
          }
          adjustBalance(state, -plan.add * unitCostCents(batch, hit));
          hit.MaxAssignments += plan.add;
          // 만료된 HIT는 자리를 늘려도 worker에게 보이지 않으므로 게시 기간만큼 연장한다 (UpdateExpirationForHIT)
          const expirationExtended = isExpired(hit, at);
          if (expirationExtended) {
            hit.Expiration = new Date(at.getTime() + batch.settings.LifetimeInSeconds * 1000).toISOString();
          }
          syncHit(hit, byHit.get(hit.HITId) ?? [], at);
          result.added.push({ HITId: hit.HITId, count: plan.add, expirationExtended });
        }
        return result;
      }),

    // ── Results and export ─────────────────────────────────────────────────
    getResults: (batchId) =>
      read((state) => {
        const batch = findBatch(state, batchId);
        const target = batch.settings.MaxAssignments;
        const items = collectItems(approvedVotes(state, batch));
        return { target, items, ...summarizeResults(items, target) };
      }),

    exportBatch: (batchId, format) =>
      read((state) => {
        const batch = findBatch(state, batchId);
        const base = slug(batch.name) || batch.id;
        if (format === 'mturk-csv') {
          const hits = state.hits.filter((h) => h.batchId === batchId);
          const hitIds = new Set(hits.map((h) => h.HITId));
          return {
            filename: `${base}-results.csv`,
            mimeType: 'text/csv;charset=utf-8',
            content: buildMturkCsv(batch, hits, state.assignments.filter((a) => hitIds.has(a.HITId))),
          };
        }
        if (format === 'labels-json') {
          return {
            filename: `${base}-labels.json`,
            mimeType: 'application/json',
            content: buildLabelsJson(collectItems(approvedVotes(state, batch))),
          };
        }
        return invalid(`Unknown export format: ${String(format)}`);
      }),

    // ── Workers and pools ──────────────────────────────────────────────────
    listWorkers: (q) =>
      read((state) =>
        applyListQuery(workersOf(state), q, {
          customFilters: {
            search: (worker, value) => worker.WorkerId.toLowerCase().includes(String(value).toLowerCase()),
            poolId: (worker, value) => worker.poolIds.includes(String(value)),
            notInPool: (worker, value) => !worker.poolIds.includes(String(value)),
            minApproved: threshold((w) => w.stats.approved, (actual, limit) => actual >= limit),
            maxRejectRate: threshold((w) => w.stats.rejectRate, (actual, limit) => actual <= limit),
            maxAttentionFailRate: threshold((w) => w.stats.attentionFailRate, (actual, limit) => actual <= limit),
            minAgreement: threshold((w) => w.stats.majorityAgreement, (actual, limit) => actual >= limit),
          },
        }),
      ),

    getWorker: (id) =>
      read((state): WorkerDetail => {
        const worker = workersOf(state).find((w) => w.WorkerId === id) ?? notFound('Worker', id);
        const hitById = new Map(state.hits.map((h) => [h.HITId, h]));
        const batchById = new Map(state.batches.map((b) => [b.id, b]));
        const own = state.assignments
          .filter((a) => a.WorkerId === id && hitById.has(a.HITId))
          .sort((a, b) => b.SubmitTime.localeCompare(a.SubmitTime));
        const perBatch = groupBy(own, (a) => hitById.get(a.HITId)!.batchId);
        return {
          ...worker,
          blockReason: state.workerMeta[id]?.blockReason,
          batches: [...perBatch].map(([batchId, list]) => {
            const counts = countByStatus(list);
            return {
              batchId,
              batchName: batchById.get(batchId)?.name ?? batchId,
              total: list.length,
              approved: counts.approved,
              rejected: counts.rejected,
              pending: counts.submitted,
            };
          }),
          assignments: own.map((a) => {
            const hit = hitById.get(a.HITId)!;
            return {
              AssignmentId: a.AssignmentId,
              HITId: a.HITId,
              batchId: hit.batchId,
              rowIndex: hit.rowIndex,
              AssignmentStatus: a.AssignmentStatus,
              SubmitTime: a.SubmitTime,
              workTimeInSeconds: a.workTimeInSeconds,
              attention: a.attention,
              RequesterFeedback: a.RequesterFeedback,
            };
          }),
        };
      }),

    updateWorkerNote: (id, note) =>
      write((state) => {
        if (typeof note !== 'string') invalid('"note" must be a string.');
        const worker = workersOf(state).find((w) => w.WorkerId === id) ?? notFound('Worker', id);
        metaOf(state, id).note = note;
        return { ...worker, note };
      }),

    listPools: () => read((state) => state.pools),

    createPool: (req) =>
      write((state) => {
        objectBody(req, 'pool');
        const name = typeof req.name === 'string' ? req.name.trim() : '';
        if (!name) invalid('Pool name is required.');
        if (state.pools.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
          invalid(`A pool named "${name}" already exists.`);
        }
        let id = `pool-${slug(name) || 'pool'}`;
        for (let n = 2; state.pools.some((p) => p.id === id); n += 1) id = `pool-${slug(name) || 'pool'}-${n}`;
        const pool = { id, name, description: typeof req.description === 'string' ? req.description.trim() : '', workerIds: [] };
        state.pools.push(pool);
        return pool;
      }),

    addWorkersToPool: (poolId, workerIds) =>
      write((state) => {
        const pool = findPool(state, poolId);
        stringArray(workerIds, 'workerIds');
        if (workerIds.length === 0) invalid('No workers selected.');
        pool.workerIds = [...new Set([...pool.workerIds, ...workerIds])];
        return pool;
      }),

    removeWorkersFromPool: (poolId, workerIds) =>
      write((state) => {
        const pool = findPool(state, poolId);
        const remove = new Set(stringArray(workerIds, 'workerIds'));
        pool.workerIds = pool.workerIds.filter((id) => !remove.has(id));
        return pool;
      }),

    blockWorkers: (ids, reason) =>
      write((state) => {
        stringArray(ids, 'ids');
        if (ids.length === 0) invalid('No workers selected.');
        if (typeof reason !== 'string' || !reason.trim()) invalid('A reason is required to block a worker. MTurk records it.');
        for (const id of ids) {
          const meta = metaOf(state, id);
          meta.blocked = true;
          meta.blockReason = reason.trim();
        }
      }),

    unblockWorkers: (ids) =>
      write((state) => {
        for (const id of stringArray(ids, 'ids')) {
          const meta = metaOf(state, id);
          meta.blocked = false;
          delete meta.blockReason;
        }
      }),

    getAccount: () => read((state) => state.account),
  };
}

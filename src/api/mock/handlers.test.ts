// mock Api의 변경 동작: 검수, 재모집, 게시, 결과, export, worker pool, 가짜 제출 (명세 5.3, 5.4, 7.2, 7.3, 8장)

import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { judgeAttention } from '../../domain/attention';
import type { CreateBatchRequest, HitSettings } from '../types';
import { createMockApi } from './handlers';
import { assembleState } from './seedFiles';
import { readSeedFiles } from './seedFromDisk';
import { createMemorySnapshot } from './snapshot';
import { MockStore, type StoreState } from './store';
import { createMockTools } from './tools';

const files = readSeedFiles(resolve(process.cwd(), 'data'));
const F1 = 'batch-1000001';
// F1의 게시 기간(2025-11-08까지)이 지난 뒤. 반려 번복 30일 제한은 테스트마다 따로 다룬다.
const NOW = new Date('2026-09-19T00:00:00Z');

/** Math.random 대신 쓰는 결정적 난수 (mulberry32) */
function seeded(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function setup(now: Date = NOW) {
  const snapshot = createMemorySnapshot<StoreState>();
  const store = new MockStore({ snapshot, loadSeed: async () => assembleState(structuredClone(files), now) });
  const clock = { now };
  const options = { delayMs: [0, 0] as [number, number], now: () => clock.now, random: seeded(7) };
  return { store, snapshot, clock, api: createMockApi(store, options), tools: createMockTools(store, options) };
}

const SETTINGS: HitSettings = {
  Title: 'Sentence-passage relevance',
  Description: 'Read a passage and judge sentences.',
  Keywords: 'English, Reading',
  Reward: '0.10',
  MaxAssignments: 3,
  AssignmentDurationInSeconds: 1800,
  LifetimeInSeconds: 30 * 24 * 3600,
  AutoApprovalDelayInSeconds: 30 * 24 * 3600,
  QualificationRequirements: [],
};

async function sampleBatchRequest(api: ReturnType<typeof setup>['api'], rows = 10): Promise<CreateBatchRequest> {
  const template = await api.saveTemplate({
    name: 'Sample relevance',
    html: '<html><head></head><body><script>var d = window.TASK_DATA;</script></body></html>',
  });
  return {
    name: 'demo batch',
    templateId: template.id,
    inputColumns: ['item_id', 'passage'],
    rows: Array.from({ length: rows }, (_, i) => ({ item_id: `s${i}`, passage: `passage ${i}` })),
    settings: SETTINGS,
    attentionRule: { namePrefix: 'attention_', expectedValue: 'not_grounded', minCorrectRatio: 1 },
    requiredPoolIds: [],
    excludedPoolIds: [],
    answerSchema: [
      { name: 'general_1', values: ['grounded', 'not_grounded'] },
      { name: 'attention_1', values: ['grounded', 'not_grounded'] },
    ],
  };
}

describe('검수 (5.3): M2 완료 기준 "F1에서 Submitted 6건을 검수해 처리할 수 있다"', () => {
  it('승인하면 상태, 시각, 진행률이 바뀌고 스냅샷에 저장된다', async () => {
    const { api, snapshot } = setup();
    const submitted = await api.listAssignments(F1, { page: 1, pageSize: 50, filters: { AssignmentStatus: 'Submitted' } });
    expect(submitted.total).toBe(6);

    const before = await api.getBatch(F1);
    const approved = await api.approveAssignments(submitted.items.map((a) => a.AssignmentId), 'Thank you.');
    expect(approved.every((a) => a.AssignmentStatus === 'Approved' && a.ApprovalTime === NOW.toISOString())).toBe(true);
    expect(approved[0]!.RequesterFeedback).toBe('Thank you.');

    const after = await api.getBatch(F1);
    expect(after.progress).toMatchObject({ submitted: 0, approved: 114, rejected: 18 });
    expect(after.needsReview).toBe(false);
    expect(after.progress.hitsCompleted).toBeGreaterThanOrEqual(before.progress.hitsCompleted);
    expect(after.cost.spentCents).toBe(114 * 6);
    expect((await snapshot.load())?.assignments.filter((a) => a.AssignmentStatus === 'Submitted')).toHaveLength(0);
  });

  it('반려에는 사유가 필요하고, Submitted만 반려할 수 있다', async () => {
    const { api } = setup();
    const { items } = await api.listAssignments(F1, { page: 1, pageSize: 50, filters: { AssignmentStatus: 'Submitted' } });
    const id = items[0]!.AssignmentId;
    await expect(api.rejectAssignments([id], '  ')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });

    const [rejected] = await api.rejectAssignments([id], 'Poor Quality.');
    expect(rejected).toMatchObject({ AssignmentStatus: 'Rejected', RequesterFeedback: 'Poor Quality.', RejectionTime: NOW.toISOString() });

    await expect(api.rejectAssignments([id], 'Poor Quality.')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    const approvedId = (await api.listAssignments(F1, { page: 1, pageSize: 1, filters: { AssignmentStatus: 'Approved' } })).items[0]!.AssignmentId;
    await expect(api.rejectAssignments([approvedId], 'Poor Quality.')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('여러 건 중 하나라도 처리할 수 없으면 아무것도 바꾸지 않는다', async () => {
    const { api } = setup();
    const { items } = await api.listAssignments(F1, { page: 1, pageSize: 50, filters: { AssignmentStatus: 'Submitted' } });
    const ids = [...items.map((a) => a.AssignmentId), 'NO_SUCH_ASSIGNMENT'];
    await expect(api.rejectAssignments(ids, 'Poor Quality.')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await api.getBatch(F1)).progress.submitted).toBe(6);
  });

  it('반려 번복(OverrideRejection)은 30일 이내에만 된다', async () => {
    const { api, clock } = setup();
    const { items } = await api.listAssignments(F1, { page: 1, pageSize: 50, filters: { AssignmentStatus: 'Submitted' } });
    const id = items[0]!.AssignmentId;
    await api.rejectAssignments([id], 'Poor Quality.');

    await expect(api.approveAssignments([id])).rejects.toMatchObject({ code: 'INVALID_REQUEST' }); // override 없이
    clock.now = new Date(NOW.getTime() + 29 * 24 * 3600 * 1000);
    const [reverted] = await api.approveAssignments([id], undefined, true);
    expect(reverted).toMatchObject({ AssignmentStatus: 'Approved' });
    expect(reverted).not.toHaveProperty('RejectionTime');

    // 케이스 스터디에서 2025-10에 반려된 건은 이미 30일이 지났다
    const old = (await api.listAssignments(F1, { page: 1, pageSize: 1, filters: { AssignmentStatus: 'Rejected' } })).items[0]!;
    await expect(api.approveAssignments([old.AssignmentId], undefined, true)).rejects.toThrow(/more than 30 days/);
  });

  it('잔액: 반려하면 돌려받고, 번복하면 다시 낸다', async () => {
    const { api } = setup();
    const { items } = await api.listAssignments(F1, { page: 1, pageSize: 50, filters: { AssignmentStatus: 'Submitted' } });
    await api.rejectAssignments([items[0]!.AssignmentId], 'Poor Quality.');
    expect((await api.getAccount()).AvailableBalance).toBe('500.06'); // $0.05 + 최소 수수료 $0.01
    await api.approveAssignments([items[0]!.AssignmentId], undefined, true);
    expect((await api.getAccount()).AvailableBalance).toBe('500.00');
  });

  it('Review 표의 Row, Agree 열과 필터', async () => {
    const { api } = setup();
    const all = await api.listAssignments(F1, { page: 1, pageSize: 200 });
    expect(all.total).toBe(132);
    for (const a of all.items) {
      expect(a.rowIndex).toBeGreaterThanOrEqual(0);
      expect(a.agreement === null || (a.agreement >= 0 && a.agreement <= 1)).toBe(true);
    }
    const failed = await api.listAssignments(F1, { page: 1, pageSize: 200, filters: { attention: 'fail' } });
    expect(failed.total).toBe(25); // Approved 14 + Rejected 11
    const fast = await api.listAssignments(F1, { page: 1, pageSize: 200, filters: { maxWorkTime: 120 } });
    expect(fast.items.every((a) => a.workTimeInSeconds < 120)).toBe(true);
    const oneHit = await api.listAssignments(F1, { page: 1, pageSize: 50, filters: { HITId: all.items[0]!.HITId } });
    expect(oneHit.items.every((a) => a.HITId === all.items[0]!.HITId)).toBe(true);
  });
});

describe('재모집 (8.3): M2 완료 기준 "반려 후 재모집하면 Open 수가 늘고 9개 상한이 지켜진다"', () => {
  it('반려하면 부족분이 생기고, fill-to-target이 그만큼 추가하며 만료된 HIT의 게시 기간을 연장한다', async () => {
    const { api } = setup();
    // F1의 0번 행: MaxAssignments 6, 반려 3, 검수 대기 2, 열린 자리 1. 검수 대기가 목표를 채울 수도 있어 아직 부족분은 없다.
    const row0 = (await api.listHits(F1, { page: 1, pageSize: 1, sort: { field: 'rowIndex', order: 'asc' } })).items[0]!;
    expect(row0).toMatchObject({ MaxAssignments: 6, expired: true });
    expect(row0.progress).toMatchObject({ approved: 0, rejected: 3, submitted: 2, open: 1, shortfall: 0 });

    const pending = await api.listAssignments(F1, { page: 1, pageSize: 10, filters: { HITId: row0.HITId, AssignmentStatus: 'Submitted' } });
    await api.rejectAssignments(pending.items.map((a) => a.AssignmentId), 'Failed to pass the attention check task.');
    const rejected = (await api.listHits(F1, { page: 1, pageSize: 1, filters: { HITId: row0.HITId } })).items[0]!;
    expect(rejected.progress).toMatchObject({ rejected: 5, submitted: 0, open: 1, shortfall: 2 }); // 반려해도 자리는 다시 열리지 않는다

    const result = await api.addAssignments([row0.HITId], 'fill-to-target');
    expect(result).toEqual({ added: [{ HITId: row0.HITId, count: 2, expirationExtended: true }], skipped: [] });

    const after = (await api.listHits(F1, { page: 1, pageSize: 1, filters: { HITId: row0.HITId } })).items[0]!;
    expect(after).toMatchObject({ MaxAssignments: 8, expired: false, HITStatus: 'Assignable' });
    expect(after.progress).toMatchObject({ open: 3, shortfall: 0 });
    expect((await api.getBatch(F1)).status).toBe('in_progress');
    expect((await api.getAccount()).AvailableBalance).toBe('500.00'); // 반려로 2건 환불, 추가로 2건 선결제
  });

  it('부족분은 없지만 만료되어 막힌 HIT는 추가 없이 게시 기간만 연장한다', async () => {
    const { api } = setup();
    const stuck = await api.listHits(F1, { page: 1, pageSize: 100, filters: { incomplete: true } });
    expect(stuck.items.map((h) => [h.rowIndex, h.progress.shortfall, h.progress.open, h.expired])).toEqual([
      [0, 0, 1, true], [1, 0, 3, true], [2, 0, 1, true], [3, 0, 1, true],
    ]);
    const result = await api.addAssignments(stuck.items.map((h) => h.HITId), 'fill-to-target');
    expect(result.added.map((a) => [a.count, a.expirationExtended])).toEqual([[0, true], [0, true], [0, true], [0, true]]);

    const after = await api.listHits(F1, { page: 1, pageSize: 100, filters: { incomplete: true } });
    expect(after.items.every((h) => !h.expired && h.HITStatus === 'Assignable')).toBe(true);
    expect(after.items.map((h) => h.MaxAssignments)).toEqual(stuck.items.map((h) => h.MaxAssignments));

    // 완료된 HIT와, 숫자를 지정한 추가에는 적용하지 않는다
    const done = (await api.listHits(F1, { page: 1, pageSize: 1, sort: { field: 'rowIndex', order: 'desc' } })).items[0]!;
    expect((await api.addAssignments([done.HITId], 'fill-to-target')).skipped).toHaveLength(1);
  });

  it('9개 상한: 넘는 HIT는 건너뛰고 사유를 알려준다', async () => {
    const { api } = setup();
    const { items } = await api.listHits(F1, { page: 1, pageSize: 1, sort: { field: 'MaxAssignments', order: 'desc' } });
    const hit = items[0]!;
    expect(hit.MaxAssignments).toBe(6);

    const ok = await api.addAssignments([hit.HITId], 3);
    expect(ok.added).toEqual([{ HITId: hit.HITId, count: 3, expirationExtended: true }]);
    const over = await api.addAssignments([hit.HITId], 1);
    expect(over.added).toEqual([]);
    expect(over.skipped[0]!.reason).toMatch(/cannot exceed 9/);
    expect((await api.getHit(hit.HITId)).MaxAssignments).toBe(9);
  });

  it('getHit은 입력 전체를, listHits는 잘라낸 입력을 준다', async () => {
    const { api } = setup();
    const { items } = await api.listHits(F1, { page: 1, pageSize: 1 });
    const full = await api.getHit(items[0]!.HITId);
    expect(full.input.retrieved_chunk!.length).toBeGreaterThan(1000);
    expect(items[0]!.inputPreview.retrieved_chunk!.length).toBeLessThanOrEqual(201);
    expect(items[0]).not.toHaveProperty('input');
  });
});

describe('게시 (5.2, 7.2): M1 완료 기준 "게시하면 Manage 목록에 새 batch가 생긴다"', () => {
  it('행 수만큼 HIT를 만들고 모든 자리가 열린 상태로 둔다. 비용은 잔액에서 미리 빠진다', async () => {
    const { api } = setup();
    const request = await sampleBatchRequest(api);
    const batch = await api.createBatch(request);

    const list = await api.listBatches();
    expect(list[0]!.batch.id).toBe(batch.id); // 최근 batch가 맨 위
    expect(list[0]).toMatchObject({ status: 'in_progress', needsReview: false });
    expect(list[0]!.progress).toMatchObject({ hitsTotal: 10, hitsCompleted: 0, open: 30, submitted: 0 });
    expect(list[0]!.cost).toEqual({ spentCents: 0, estimatedCents: 30 * 12 });

    const hits = await api.listHits(batch.id, { page: 1, pageSize: 100, sort: { field: 'rowIndex', order: 'asc' } });
    expect(hits.items.map((h) => h.inputPreview.item_id)).toEqual(request.rows.map((r) => r.item_id));
    expect(hits.items.every((h) => h.HITStatus === 'Assignable' && h.initialMaxAssignments === 3)).toBe(true);
    expect((await api.getAccount()).AvailableBalance).toBe('496.40'); // 30 × ($0.10 + $0.02)
    expect((await api.getBatch(batch.id)).batch.templateHtml).toContain('TASK_DATA');
  });

  it('템플릿 placeholder가 CSV에 없으면 막는다 (치환되지 않은 ${x}는 템플릿의 JS를 깨뜨린다)', async () => {
    const { api } = setup();
    const request = await sampleBatchRequest(api);
    await expect(
      api.createBatch({ ...request, templateId: 'tpl-chunk-fact-relevance' }),
    ).rejects.toThrow(/missing columns.*\$\{idx\}/);
  });

  it('잔액이 모자라면 막고 아무것도 만들지 않는다', async () => {
    const { api } = setup();
    const request = await sampleBatchRequest(api, 10);
    const expensive = { ...request, settings: { ...SETTINGS, Reward: '20.00' } };
    await expect(api.createBatch(expensive)).rejects.toThrow(/Insufficient balance/);
    expect(await api.listBatches()).toHaveLength(3);
  });

  it('게시한 뒤 템플릿을 고치거나 지워도 batch의 사본은 그대로다', async () => {
    const { api } = setup();
    const request = await sampleBatchRequest(api);
    const batch = await api.createBatch(request);
    await api.saveTemplate({ id: request.templateId, name: 'Sample relevance', html: '<p>changed ${passage}</p>' });
    expect((await api.getTemplate(request.templateId)).placeholders).toEqual(['passage']);
    await api.deleteTemplate(request.templateId);
    expect((await api.getBatch(batch.id)).batch.templateHtml).toContain('TASK_DATA');
    await expect(api.getTemplate(request.templateId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('"지금 만료"는 남은 HIT를 닫는다', async () => {
    const { api } = setup();
    const batch = await api.createBatch(await sampleBatchRequest(api));
    await api.expireBatch(batch.id);
    const detail = await api.getBatch(batch.id);
    expect(detail.status).toBe('expired');
    const hits = await api.listHits(batch.id, { page: 1, pageSize: 100 });
    expect(hits.items.every((h) => h.expired && h.HITStatus === 'Reviewable')).toBe(true);
  });
});

describe('가짜 제출 생성 (7.3)', () => {
  it('자리가 열린 HIT에만 Submitted를 만들고, 게시할 때 읽어 둔 문항으로 응답을 채운다', async () => {
    const { api, tools } = setup();
    const batch = await api.createBatch(await sampleBatchRequest(api, 5));
    const result = await tools.generateFakeSubmissions({ count: 100, batchId: batch.id });
    expect(result).toMatchObject({ created: 15, requested: 100 }); // 5 HIT × 3자리
    expect(result.note).toMatch(/No more open assignments/);

    const { items } = await api.listAssignments(batch.id, { page: 1, pageSize: 100 });
    expect(items).toHaveLength(15);
    for (const a of items) {
      expect(a.AssignmentStatus).toBe('Submitted');
      expect(a.answers.map((x) => x.name)).toEqual(['general_1', 'attention_1']);
      expect(a.attention).toEqual(judgeAttention(a.answers, batch.attentionRule));
      expect(a.workTimeInSeconds).toBeGreaterThanOrEqual(30);
      expect(a.workTimeInSeconds).toBeLessThanOrEqual(1200);
    }
    // 같은 worker가 같은 HIT를 두 번 하지 않는다
    const pairs = items.map((a) => `${a.HITId}|${a.WorkerId}`);
    expect(new Set(pairs).size).toBe(pairs.length);
    expect((await api.getBatch(batch.id)).needsReview).toBe(true);
  });

  it('만료된 HIT에는 만들지 않는다. 재모집으로 연장하면 만들어진다', async () => {
    const { api, tools } = setup();
    expect((await tools.generateFakeSubmissions({ count: 5, batchId: F1 })).created).toBe(0);
    const { items } = await api.listHits(F1, { page: 1, pageSize: 100, filters: { incomplete: true } });
    await api.addAssignments(items.map((h) => h.HITId), 'fill-to-target');
    const result = await tools.generateFakeSubmissions({ count: 50, batchId: F1 });
    expect(result.created).toBe(6); // 다시 열린 자리 1 + 3 + 1 + 1
    // 같은 HIT의 기존 응답과 같은 문항 이름을 쓴다
    const created = await api.listAssignments(F1, { page: 1, pageSize: 1, sort: { field: 'SubmitTime', order: 'desc' } });
    expect(created.items[0]!.answers.some((a) => a.name.startsWith('attention_'))).toBe(true);
  });

  it('M3 완료 기준: Excluded pool의 worker는 새 batch에 참여하지 못하고, required pool이면 그 worker만 참여한다', async () => {
    const { api, tools } = setup();
    const workers = (await api.listWorkers({ page: 1, pageSize: 100 })).items.map((w) => w.WorkerId);
    await api.addWorkersToPool('pool-excluded', workers.slice(0, 50));
    await api.addWorkersToPool('pool-trusted', workers.slice(50, 55));

    const request = await sampleBatchRequest(api, 4);
    const excluding = await api.createBatch({ ...request, name: 'excluding', excludedPoolIds: ['pool-excluded'] });
    await tools.generateFakeSubmissions({ count: 100, batchId: excluding.id });
    const first = await api.listAssignments(excluding.id, { page: 1, pageSize: 100 });
    expect(first.items.some((a) => workers.slice(0, 50).includes(a.WorkerId))).toBe(false);

    const trustedOnly = await api.createBatch({ ...request, name: 'trusted only', requiredPoolIds: ['pool-trusted'] });
    await tools.generateFakeSubmissions({ count: 100, batchId: trustedOnly.id });
    const second = await api.listAssignments(trustedOnly.id, { page: 1, pageSize: 100 });
    expect(second.total).toBe(12);
    expect(second.items.every((a) => workers.slice(50, 55).includes(a.WorkerId))).toBe(true);
  });
});

describe('Results와 export (5.3, 8.4)', () => {
  it('Approved의 실제 문항만 세고, κ는 투표 수가 target인 문항만으로 계산한다', async () => {
    const { api } = setup();
    const results = await api.getResults(F1);
    expect(results.target).toBe(3);
    expect(results.items.every((i) => !i.answerName.startsWith('attention_'))).toBe(true);
    expect(results.items.reduce((sum, i) => sum + i.votes.length, 0)).toBe(
      Object.values(results.labelDistribution).reduce((a, b) => a + b, 0),
    );
    expect(results.kappaItemCount).toBe(results.items.filter((i) => i.votes.length === 3).length);
    expect(results.fleissKappa).toBeGreaterThan(-1);
    expect(results.fleissKappa).toBeLessThan(1);
    expect(Object.keys(results.labelDistribution).sort()).toEqual(['grounded', 'not_grounded']);
  });

  // M2 완료 기준 (8.4): 기존 *_iaa.py가 쓰는 statsmodels.stats.inter_rater.fleiss_kappa와 소수 셋째 자리까지 같아야 한다.
  // 기준값은 data/의 같은 데이터(Approved, attention 제외, 투표 3건인 문항)를 statsmodels 0.14로 계산한 것이다.
  it('Fleiss κ가 statsmodels의 값과 같다', async () => {
    const { api } = setup();
    const reference = { 'batch-1000001': [420, 0.730594], 'batch-1000003': [241, 0.938407], 'batch-1000002': [326, 0.856749] } as const;
    for (const [batchId, [items, kappa]] of Object.entries(reference)) {
      const results = await api.getResults(batchId);
      expect(results.kappaItemCount).toBe(items);
      expect(results.fleissKappa).toBeCloseTo(kappa, 5);
    }
  });

  it('MTurk 결과 CSV 호환 형식: 기존 *_iaa.py가 읽는 컬럼이 있다', async () => {
    const { api } = setup();
    const file = await api.exportBatch(F1, 'mturk-csv');
    expect(file.filename).toBe('pilot-close-ended-chunk-fact-results.csv');
    const header = file.content.slice(0, file.content.indexOf('\r\n')).split(',');
    for (const column of ['HITId', 'WorkerId', 'AssignmentStatus', 'Input.idx', 'Input.qid', 'Input.retrieved_chunk', 'Input.attention_check', 'Answer.taskAnswers']) {
      expect(header).toContain(column);
    }
    expect(file.content).toContain('[{""input_answers"":""[{\\""name\\"":');
  });

  it('라벨 JSON: { "<rowIndex>:<answerName>": { votes, majority, workers } }', async () => {
    const { api } = setup();
    const labels = JSON.parse((await api.exportBatch(F1, 'labels-json')).content) as Record<string, { votes: string[]; majority: string | null; workers: string[] }>;
    const [key, label] = Object.entries(labels)[0]!;
    expect(key).toMatch(/^\d+:general_\d+_\d+$/);
    expect(label.votes.length).toBe(label.workers.length);
    expect(Object.keys(labels)).toHaveLength((await api.getResults(F1)).items.length);
  });
});

describe('Worker pool (5.4)', () => {
  it('pool 만들기, 추가, 제거. 이름이 같은 pool은 만들 수 없다', async () => {
    const { api } = setup();
    const pool = await api.createPool({ name: 'Pilot regulars', description: 'Did well in the pilot' });
    expect(pool.id).toBe('pool-pilot-regulars');
    await expect(api.createPool({ name: 'pilot REGULARS', description: '' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });

    const workers = (await api.listWorkers({ page: 1, pageSize: 3 })).items.map((w) => w.WorkerId);
    expect((await api.addWorkersToPool(pool.id, [...workers, workers[0]!])).workerIds).toEqual(workers);
    expect((await api.removeWorkersFromPool(pool.id, [workers[0]!])).workerIds).toEqual(workers.slice(1));
    expect((await api.getWorker(workers[1]!)).poolIds).toEqual([pool.id]);
  });

  it('"조건으로 채우기"에 쓰는 필터: 값이 없는 worker는 조건을 만족하지 않는 것으로 본다', async () => {
    const { api } = setup();
    const strict = await api.listWorkers({
      page: 1,
      pageSize: 100,
      filters: { minApproved: 5, maxAttentionFailRate: 0, minAgreement: 0.9 },
    });
    expect(strict.total).toBeGreaterThan(0);
    expect(strict.total).toBeLessThan(60);
    for (const w of strict.items) {
      expect(w.stats.approved).toBeGreaterThanOrEqual(5);
      expect(w.stats.attentionFailRate).toBe(0);
      expect(w.stats.majorityAgreement!).toBeGreaterThanOrEqual(0.9);
    }
    await api.addWorkersToPool('pool-trusted', strict.items.map((w) => w.WorkerId));
    const rest = await api.listWorkers({ page: 1, pageSize: 100, filters: { minApproved: 5, maxAttentionFailRate: 0, minAgreement: 0.9, notInPool: 'pool-trusted' } });
    expect(rest.total).toBe(0);
  });

  it('차단에는 사유가 필요하고, 메모와 함께 worker 상세에 나온다', async () => {
    const { api } = setup();
    const id = (await api.listWorkers({ page: 1, pageSize: 1, sort: { field: 'stats.rejectRate', order: 'desc' } })).items[0]!.WorkerId;
    await expect(api.blockWorkers([id], '')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await api.blockWorkers([id], 'Repeated random answers');
    await api.updateWorkerNote(id, 'Rejected 7 of 7 in the pilot');

    const detail = await api.getWorker(id);
    expect(detail).toMatchObject({ blocked: true, blockReason: 'Repeated random answers', note: 'Rejected 7 of 7 in the pilot' });
    expect(detail.assignments).toHaveLength(detail.stats.total);
    expect(detail.batches.reduce((sum, b) => sum + b.total, 0)).toBe(detail.stats.total);
    expect((await api.listWorkers({ page: 1, pageSize: 10, filters: { blocked: true } })).total).toBe(1);

    await api.unblockWorkers([id]);
    expect((await api.getWorker(id)).blocked).toBe(false);
  });
});

describe('데이터 내보내기와 가져오기 (Mock tools)', () => {
  it('내보낸 JSON을 다른 저장소로 가져오면 같은 상태가 된다', async () => {
    const source = setup();
    await source.api.createPool({ name: 'Exported pool', description: '' });
    const file = await source.tools.exportState();
    expect(file.filename).toMatch(/^mturk-console-data-\d{12}\.json$/);

    const target = setup();
    const info = await target.tools.importState(file.content);
    expect(info).toMatchObject({ source: 'snapshot', counts: { batches: 3, assignments: 231, pools: 3 } });
    expect((await target.api.listPools()).map((p) => p.name)).toContain('Exported pool');
    // 가져온 상태는 저장되어 새로고침 뒤에도 남는다
    expect((await target.snapshot.load())?.pools).toHaveLength(3);
  });

  it('콘솔 데이터 파일이 아니면 거절하고 상태를 바꾸지 않는다', async () => {
    const { api, tools } = setup();
    await expect(tools.importState('not json')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(tools.importState('{"batches": []}')).rejects.toThrow(/not a console data file/);
    await expect(tools.importState(JSON.stringify({ format: 'mturk-console-state', version: 1, state: { templates: [] } }))).rejects.toThrow(/incomplete/);
    expect(await api.listBatches()).toHaveLength(3);
  });
});

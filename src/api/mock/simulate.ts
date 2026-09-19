// 7.3 가짜 제출 생성. 새로 게시한 batch는 응답이 없어 Manage 흐름을 볼 수 없으므로, 자리가 열린 HIT에
// Submitted assignment를 만든다. mock 구현에만 있고 API 인터페이스에는 넣지 않는다.

import { isAttentionName, judgeAttention } from '../../domain/attention';
import { isExpired } from '../../domain/progress';
import type { AnswerField, Assignment, Batch } from '../types';
import { attentionPrefixOf, groupBy, mturkLikeId, syncHit } from './handlers';
import type { StoreState } from './store';

export const ATTENTION_CORRECT_PROBABILITY = 0.85;
const EXISTING_WORKER_PROBABILITY = 0.7;
const MIN_WORK_SECONDS = 30;
const MAX_WORK_SECONDS = 20 * 60;

// 템플릿에서 문항을 읽어 내지 못했고 참고할 응답도 없을 때 쓰는 기본 문항
const FALLBACK_SCHEMA: AnswerField[] = [
  { name: 'general_1', values: ['yes', 'no'] },
  { name: 'general_2', values: ['yes', 'no'] },
  { name: 'attention_1', values: ['yes', 'no'] },
];

export interface FakeSubmissionRequest {
  count: number;
  batchId?: string; // 없으면 자리가 열린 모든 batch
}

export interface FakeSubmissionResult {
  created: number;
  requested: number;
  byBatch: { batchId: string; batchName: string; created: number }[];
  note?: string; // 요청보다 적게 만들었을 때의 이유
}

function pick<T>(items: readonly T[], random: () => number): T {
  return items[Math.floor(random() * items.length)]!;
}

/**
 * HIT의 문항 목록을 정한다. 콘솔은 템플릿을 해석하지 않으므로 아는 정보를 순서대로 쓴다:
 * 같은 HIT의 기존 응답 → 게시할 때 미리보기에서 읽어 둔 answerSchema → 같은 batch의 다른 응답 → 기본 문항.
 */
function schemaFor(batch: Batch, onHit: Assignment[], inBatch: Assignment[]): AnswerField[] {
  const observed = new Map<string, Set<string>>();
  for (const a of inBatch) {
    for (const answer of a.answers) {
      const prefix = answer.name.split('_')[0]!;
      const values = observed.get(prefix) ?? new Set<string>();
      values.add(answer.value);
      observed.set(prefix, values);
    }
  }
  const valuesOf = (name: string, fallback: string[]) => {
    const seen = [...(observed.get(name.split('_')[0]!) ?? [])];
    return seen.length >= 2 ? seen : fallback;
  };

  const reference = onHit[0] ?? (batch.answerSchema?.length ? undefined : inBatch[0]);
  if (reference) return reference.answers.map((a) => ({ name: a.name, values: valuesOf(a.name, [a.value]) }));
  if (batch.answerSchema?.length) return batch.answerSchema;
  return FALLBACK_SCHEMA;
}

function fakeAnswers(schema: AnswerField[], batch: Batch, random: () => number) {
  const prefix = attentionPrefixOf(batch);
  const expected = batch.attentionRule?.expectedValue;
  return schema.map(({ name, values }) => {
    const choices = values.length > 0 ? values : ['yes', 'no'];
    if (expected !== undefined && isAttentionName(name, prefix)) {
      const wrong = choices.filter((v) => v !== expected);
      const correct = random() < ATTENTION_CORRECT_PROBABILITY || wrong.length === 0;
      return { name, value: correct ? expected : pick(wrong, random) };
    }
    return { name, value: pick(choices, random) };
  });
}

/** state를 직접 고친다. store.update 안에서 부른다. */
export function generateFakeSubmissions(
  state: StoreState,
  request: FakeSubmissionRequest,
  context: { now: Date; random: () => number },
): FakeSubmissionResult {
  const { now, random } = context;
  const batchById = new Map(state.batches.map((b) => [b.id, b]));
  const byHit = groupBy(state.assignments, (a) => a.HITId);
  const hitBatch = new Map(state.hits.map((h) => [h.HITId, h.batchId]));
  const byBatch = groupBy(state.assignments, (a) => hitBatch.get(a.HITId) ?? '');

  const knownWorkers = [
    ...new Set([...state.assignments.map((a) => a.WorkerId), ...state.pools.flatMap((p) => p.workerIds)]),
  ].filter((id) => !state.workerMeta[id]?.blocked);
  const poolMembers = (ids: string[]) =>
    new Set(state.pools.filter((p) => ids.includes(p.id)).flatMap((p) => p.workerIds));

  const openHits = state.hits.filter(
    (hit) =>
      (!request.batchId || hit.batchId === request.batchId) &&
      !isExpired(hit, now) &&
      hit.MaxAssignments - (byHit.get(hit.HITId)?.length ?? 0) > 0,
  );

  const createdByBatch = new Map<string, number>();
  let created = 0;
  let blockedByPools = false;

  while (created < request.count && openHits.length > 0) {
    const index = Math.floor(random() * openHits.length);
    const hit = openHits[index]!;
    const batch = batchById.get(hit.batchId)!;
    const onHit = byHit.get(hit.HITId) ?? [];

    // 5.4: required pool이 있으면 그 worker만, excluded pool의 worker는 제외. 같은 worker가 같은 HIT를 두 번 하지 않는다.
    const required = batch.requiredPoolIds.length > 0 ? poolMembers(batch.requiredPoolIds) : null;
    const excluded = poolMembers(batch.excludedPoolIds);
    const already = new Set(onHit.map((a) => a.WorkerId));
    const eligible = knownWorkers.filter(
      (id) => !excluded.has(id) && !already.has(id) && (required === null || required.has(id)),
    );
    const canUseNewWorker = required === null; // 새 worker는 어떤 pool에도 없다
    if (eligible.length === 0 && !canUseNewWorker) {
      blockedByPools = true;
      openHits.splice(index, 1);
      continue;
    }
    const useExisting = eligible.length > 0 && (!canUseNewWorker || random() < EXISTING_WORKER_PROBABILITY);
    const workerId = useExisting
      ? pick(eligible, random)
      : `W${Array.from({ length: 12 }, () => Math.floor(random() * 16).toString(16)).join('')}`;
    if (!useExisting) knownWorkers.push(workerId);

    const workTime = Math.floor(MIN_WORK_SECONDS + random() * (MAX_WORK_SECONDS - MIN_WORK_SECONDS));
    const submit = new Date(now.getTime() - Math.floor(random() * 3600) * 1000);
    const answers = fakeAnswers(schemaFor(batch, onHit, byBatch.get(batch.id) ?? []), batch, random);
    const assignment: Assignment = {
      AssignmentId: mturkLikeId(random),
      HITId: hit.HITId,
      WorkerId: workerId,
      AssignmentStatus: 'Submitted',
      AcceptTime: new Date(submit.getTime() - workTime * 1000).toISOString(),
      SubmitTime: submit.toISOString(),
      AutoApprovalTime: new Date(submit.getTime() + batch.settings.AutoApprovalDelayInSeconds * 1000).toISOString(),
      answers,
      workTimeInSeconds: workTime,
      attention: judgeAttention(answers, batch.attentionRule),
    };
    state.assignments.push(assignment);
    onHit.push(assignment);
    byHit.set(hit.HITId, onHit);
    (byBatch.get(batch.id) ?? byBatch.set(batch.id, []).get(batch.id)!).push(assignment);
    syncHit(hit, onHit, now);

    created += 1;
    createdByBatch.set(batch.id, (createdByBatch.get(batch.id) ?? 0) + 1);
    if (hit.MaxAssignments - onHit.length <= 0) openHits.splice(index, 1);
  }

  let note: string | undefined;
  if (created < request.count) {
    note = blockedByPools
      ? 'Some HITs require a pool that has no eligible workers left.'
      : 'No more open assignments. Publish a batch or top up HITs first (expired HITs do not accept work).';
  }
  return {
    created,
    requested: request.count,
    byBatch: [...createdByBatch].map(([batchId, n]) => ({
      batchId,
      batchName: batchById.get(batchId)?.name ?? batchId,
      created: n,
    })),
    note,
  };
}

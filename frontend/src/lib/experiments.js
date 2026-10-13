// 실험 결과 비교와 Generate 초안. 원본 데이터와 API 허용 상태는 localStorage에 저장하지 않는다.
import { CANDIDATE_COUNT } from './job-groups.js';

export const GENERATE_DRAFT_KEY = 'mturk-console:generate-draft:v1';

export function normalizeGenerateDraft(value) {
  const v = value && typeof value === 'object' ? value : {};
  const text = (key) => typeof v[key] === 'string' ? v[key] : '';
  const source = v.source && typeof v.source.source_job_id === 'string' ? {
    source_job_id: v.source.source_job_id, raw_name: String(v.source.raw_name || ''), has_spec: Boolean(v.source.has_spec),
  } : null;
  // 후보마다 고른 모델 설정 이름. 예전 초안의 model_config(하나)는 첫 후보의 모델로 읽는다
  const models = Array.isArray(v.model_configs) ? v.model_configs : text('model_config') ? [v.model_config] : [];
  const model_configs = models.slice(0, CANDIDATE_COUNT).map((name) => (typeof name === 'string' ? name : ''));
  return { name: text('name'), prompt_text: text('prompt_text'), model_configs, source };
}

export function readGenerateDraft(storage) {
  try { return normalizeGenerateDraft(JSON.parse(storage.getItem(GENERATE_DRAFT_KEY))); }
  catch { return normalizeGenerateDraft(null); }
}

export function saveGenerateDraft(storage, value) {
  try { storage.setItem(GENERATE_DRAFT_KEY, JSON.stringify(normalizeGenerateDraft(value))); return true; }
  catch { return false; }
}

// Tutorial 의 예시 prompt 버튼 → Generate 폼. prompt 와 이름은 Generate 초안(localStorage)에 쓰고, 무엇을 불러왔는지는
// sessionStorage 에 한 번만 읽히는 표시로 남긴다. 'prompt' 면 prompt 만, 'prompt+data' 면 합성 예시 원본도 폼이 불러온다.
export const EXAMPLE_REQUEST_KEY = 'mturk-console:generate-example';
const EXAMPLE_REQUESTS = ['prompt', 'prompt+data'];

/** 예시 prompt 를 초안에 넣는다. 원본까지 바꿀 때는 이전 job 의 원본 참조(source)를 지운다. */
export function draftWithExample(draft, example, withData) {
  const current = normalizeGenerateDraft(draft);
  return { ...current, name: String(example.name ?? ''), prompt_text: String(example.prompt_text ?? ''), source: withData ? null : current.source };
}

/** Tutorial 에서 부른다. 초안을 저장하고 표시를 남겼으면 true. */
export function requestGenerateExample(local, session, example, withData) {
  try {
    if (!saveGenerateDraft(local, draftWithExample(readGenerateDraft(local), example, withData))) return false;
    session.setItem(EXAMPLE_REQUEST_KEY, withData ? 'prompt+data' : 'prompt');
    return true;
  } catch {
    return false;
  }
}

/** Generate 폼이 열릴 때 부른다. 남은 표시를 지우고 돌려준다 ('prompt' | 'prompt+data' | null). */
export function takeGenerateExampleRequest(session) {
  try {
    const value = session.getItem(EXAMPLE_REQUEST_KEY);
    session.removeItem(EXAMPLE_REQUEST_KEY);
    return EXAMPLE_REQUESTS.includes(value) ? value : null;
  } catch {
    return null;
  }
}

export function generalRowKey(row) {
  try {
    const ids = JSON.parse(row.record_ids), items = JSON.parse(row.item_ids), attention = JSON.parse(row.attention);
    if (![ids, items, attention].every(Array.isArray) || ids.length !== items.length || ids.length !== attention.length) return null;
    const pairs = ids.map((id, i) => [id, items[i], attention[i]]).filter((p) => p[2] === 0).map((p) => p.slice(0, 2));
    return pairs.length ? JSON.stringify(pairs) : null;
  } catch { return null; }
}

export function sharedRows(bundles) {
  if (!bundles.length) return [];
  const indexes = bundles.map((bundle) => {
    const map = new Map();
    bundle.data.rows.forEach((row, index) => {
      const key = generalRowKey(row);
      // 같은 키가 여러 행에 있으면 모호하므로 공통 행으로 사용하지 않는다.
      if (key !== null) map.set(key, map.has(key) ? null : index);
    });
    return map;
  });
  return [...indexes[0]].filter(([key, i]) => i !== null && indexes.every((map) => map.get(key) !== undefined && map.get(key) !== null))
    .map(([key]) => ({ key, indexes: indexes.map((map) => map.get(key)) }));
}

export function comparisonWarnings(bundles) {
  if (bundles.length < 2) return [];
  const warnings = [];
  const raw = bundles.map(({ job }) => job.provenance?.raw_sha256);
  if (raw.some((v) => !v)) warnings.push('Some runs have no raw-data fingerprint; identical input cannot be confirmed.');
  else if (new Set(raw).size > 1) warnings.push('These runs used different raw data.');
  // 한 묶음의 후보는 일부러 모델만 바꿔 만든 것이라 모델 차이를 경고하지 않는다
  const groupId = bundles[0].job.group?.id;
  const sameGroup = Boolean(groupId) && bundles.every(({ job }) => job.group?.id === groupId);
  const planners = bundles.map(({ job }) => `${job.planner?.mode}:${job.planner?.model_config}`);
  if (!sameGroup && new Set(planners).size > 1) warnings.push('Planner or model settings differ between runs.');
  const policies = bundles.map(({ spec }) => JSON.stringify({ source: spec.source, limits: spec.item?.iterate?.map((v) => v.limit), hit: spec.hit }));
  if (new Set(policies).size > 1) {
    warnings.push(sameGroup
      ? 'The candidates sample, group or check attention differently. Compare their task specs as well as the previews.'
      : 'Sampling, grouping or attention settings differ. Check the task specs before judging prompt quality.');
  }
  if (bundles.some(({ job }) => job.planner?.mode === 'file')) warnings.push('A run used a saved spec: it does not measure the effect of its prompt.');
  return warnings;
}

export function experimentReport(bundles, createdAt = new Date().toISOString()) {
  return { version: 1, created_at: createdAt, warnings: comparisonWarnings(bundles), runs: bundles.map(({ job, spec, inputs }) => ({
    job_id: job.id, name: job.name, group: job.group ?? null, status: job.status, planner: job.planner, provenance: job.provenance,
    prompt_text: inputs.prompt_text, summary: job.summary, validation: job.validation, usage: job.usage,
    review: job.review ?? {}, task_spec: spec,
  })) };
}

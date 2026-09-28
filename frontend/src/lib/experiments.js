// 실험 결과 비교와 Generate 초안. 원본 데이터와 API 허용 상태는 localStorage에 저장하지 않는다.
export const GENERATE_DRAFT_KEY = 'mturk-console:generate-draft:v1';

export function normalizeGenerateDraft(value) {
  const v = value && typeof value === 'object' ? value : {};
  const text = (key) => typeof v[key] === 'string' ? v[key] : '';
  const source = v.source && typeof v.source.source_job_id === 'string' ? {
    source_job_id: v.source.source_job_id, raw_name: String(v.source.raw_name || ''), has_spec: Boolean(v.source.has_spec),
  } : null;
  return { name: text('name'), prompt_text: text('prompt_text'), model_config: text('model_config'), source };
}

export function readGenerateDraft(storage) {
  try { return normalizeGenerateDraft(JSON.parse(storage.getItem(GENERATE_DRAFT_KEY))); }
  catch { return normalizeGenerateDraft(null); }
}

export function saveGenerateDraft(storage, value) {
  try { storage.setItem(GENERATE_DRAFT_KEY, JSON.stringify(normalizeGenerateDraft(value))); return true; }
  catch { return false; }
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
  const planners = bundles.map(({ job }) => `${job.planner?.mode}:${job.planner?.model_config}`);
  if (new Set(planners).size > 1) warnings.push('Planner or model settings differ between runs.');
  const policies = bundles.map(({ spec }) => JSON.stringify({ source: spec.source, limits: spec.item?.iterate?.map((v) => v.limit), hit: spec.hit }));
  if (new Set(policies).size > 1) warnings.push('Sampling, grouping or attention settings differ. Check the task specs before judging prompt quality.');
  if (bundles.some(({ job }) => job.planner?.mode === 'file')) warnings.push('A run used a saved spec: it does not measure the effect of its prompt.');
  return warnings;
}

export function experimentReport(bundles, createdAt = new Date().toISOString()) {
  return { version: 1, created_at: createdAt, warnings: comparisonWarnings(bundles), runs: bundles.map(({ job, spec, inputs }) => ({
    job_id: job.id, name: job.name, status: job.status, planner: job.planner, provenance: job.provenance,
    prompt_text: inputs.prompt_text, summary: job.summary, validation: job.validation, usage: job.usage,
    review: job.review ?? {}, task_spec: spec,
  })) };
}

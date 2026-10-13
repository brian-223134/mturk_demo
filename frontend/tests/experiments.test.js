import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeGenerateDraft, readGenerateDraft, saveGenerateDraft, generalRowKey, sharedRows, comparisonWarnings, experimentReport } from '../src/lib/experiments.js';

const row = (id, position = 1) => ({ record_ids: JSON.stringify(position ? [id, 'attention'] : ['attention', id]), item_ids: JSON.stringify(position ? [`${id}-p1`, 'attention'] : ['attention', `${id}-p1`]), attention: JSON.stringify(position ? [0, 1] : [1, 0]) });
const bundle = (rows, overrides = {}) => ({ job: { id: 'j1', name: 'candidate', provenance: { raw_sha256: 'raw' }, planner: { mode: 'openrouter', model_config: 'default' }, review: {} }, spec: { source: { sample: null }, hit: { items_per_hit: 4 } }, inputs: { prompt_text: 'Judge support.' }, data: { rows }, ...overrides });

test('Generate draft keeps text and a source reference, but never API permission or local files', () => {
  const saved = normalizeGenerateDraft({ name: 'A', prompt_text: 'Text', model_configs: ['default', 'qwen3-235b', 'deepseek-v3.2'], allow_api: true, raw: 'private raw', source: { source_job_id: 'j1', raw_name: 'raw.json', has_spec: true } });
  assert.deepEqual(saved, { name: 'A', prompt_text: 'Text', model_configs: ['default', 'qwen3-235b', 'deepseek-v3.2'], source: { source_job_id: 'j1', raw_name: 'raw.json', has_spec: true } });
  assert.equal(normalizeGenerateDraft({ source: { raw_name: 'x' } }).source, null);
  let value = '';
  const storage = { getItem: () => value, setItem: (_, v) => { value = v; } };
  assert.equal(saveGenerateDraft(storage, saved), true);
  assert.deepEqual(readGenerateDraft(storage), saved);
  value = '{broken';
  assert.deepEqual(readGenerateDraft(storage), normalizeGenerateDraft(null));
  assert.equal(saveGenerateDraft({ setItem() { throw new Error('quota'); } }, saved), false);
});

test('Generate draft keeps at most three candidate models and reads an older single model as the first one', () => {
  assert.deepEqual(normalizeGenerateDraft({ model_config: 'qwen3-235b' }).model_configs, ['qwen3-235b']);
  assert.deepEqual(normalizeGenerateDraft({ model_configs: ['a', 7, 'b', 'c', 'd'] }).model_configs, ['a', '', 'b']);
  assert.deepEqual(normalizeGenerateDraft(null).model_configs, []);
});

test('Common groups align the actual item IDs, not CSV row position or attention position', () => {
  const result = sharedRows([bundle([row('r1'), row('r2')]), bundle([row('r2', 0), row('r1', 0)])]);
  assert.deepEqual(result.map((v) => v.indexes), [[0, 1], [1, 0]]);
  assert.equal(generalRowKey(row('r1')), generalRowKey(row('r1', 0)));
  assert.equal(generalRowKey({ record_ids: 'not json' }), null);
  assert.deepEqual(sharedRows([bundle([row('r1'), row('r1')]), bundle([row('r1')])]), []);
  assert.deepEqual(sharedRows([bundle([row('r1')]), bundle([row('r2')])]), []);
});

test('Comparisons disclose changed input, model and policy, as well as spec-only runs', () => {
  const a = bundle([row('r1')]);
  const b = bundle([row('r1')], { job: { ...a.job, provenance: { raw_sha256: 'other' }, planner: { mode: 'file' } }, spec: { source: { sample: { n: 1, seed: 7 } } } });
  assert.equal(comparisonWarnings([a, a]).length, 0);
  const warnings = comparisonWarnings([a, b]);
  for (const word of ['raw data', 'model', 'Sampling', 'saved spec']) assert.ok(warnings.some((v) => v.includes(word)));
  assert.match(comparisonWarnings([a, { ...a, job: { ...a.job, provenance: {} } }])[0], /cannot be confirmed/);
});

test('Candidates of one group differ by model on purpose, so only their spec differences are disclosed', () => {
  const candidate = (index, model, sample = null) => bundle([row('r1')], {
    job: { id: `j${index}`, name: 'g', provenance: { raw_sha256: 'raw' }, planner: { mode: 'openrouter', model_config: model }, group: { id: 'grp-1', index, size: 3 } },
    spec: { source: { sample }, hit: { items_per_hit: 4 } },
  });
  assert.deepEqual(comparisonWarnings([candidate(0, 'default'), candidate(1, 'qwen3-235b')]), []);
  const warnings = comparisonWarnings([candidate(0, 'default'), candidate(1, 'qwen3-235b', { n: 5 })]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /candidates sample/);
  const other = { ...candidate(2, 'deepseek-v3.2'), job: { ...candidate(2, 'deepseek-v3.2').job, group: { id: 'grp-2', index: 0, size: 3 } } };
  assert.ok(comparisonWarnings([candidate(0, 'default'), other]).some((v) => v.includes('model')));
  assert.deepEqual(experimentReport([candidate(1, 'qwen3-235b')], 't').runs[0].group, { id: 'grp-1', index: 1, size: 3 });
});

test('Export retains saved evaluation and the exact prompt without copying raw inputs', () => {
  const a = bundle([row('r1')]);
  a.job.review = { decision: 'shortlisted', notes: 'Clear.' };
  const result = experimentReport([a], 'fixed-time');
  assert.equal(result.created_at, 'fixed-time');
  assert.equal(result.runs[0].prompt_text, a.inputs.prompt_text);
  assert.deepEqual(result.runs[0].review, a.job.review);
  assert.equal('data' in result.runs[0], false);
});

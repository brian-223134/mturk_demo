import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeGenerateDraft, readGenerateDraft, saveGenerateDraft, generalRowKey, sharedRows, comparisonWarnings, experimentReport } from '../src/lib/experiments.js';

const row = (id, position = 1) => ({ record_ids: JSON.stringify(position ? [id, 'attention'] : ['attention', id]), item_ids: JSON.stringify(position ? [`${id}-p1`, 'attention'] : ['attention', `${id}-p1`]), attention: JSON.stringify(position ? [0, 1] : [1, 0]) });
const bundle = (rows, overrides = {}) => ({ job: { id: 'j1', name: 'candidate', provenance: { raw_sha256: 'raw' }, planner: { mode: 'openrouter', model_config: 'default' }, review: {} }, spec: { source: { sample: null }, hit: { items_per_hit: 4 } }, inputs: { prompt_text: 'Judge support.' }, data: { rows }, ...overrides });

test('Generate draft keeps text and a source reference, but never API permission or local files', () => {
  const saved = normalizeGenerateDraft({ name: 'A', prompt_text: 'Text', model_config: 'default', allow_api: true, raw: 'private raw', source: { source_job_id: 'j1', raw_name: 'raw.json', has_spec: true } });
  assert.deepEqual(saved, { name: 'A', prompt_text: 'Text', model_config: 'default', source: { source_job_id: 'j1', raw_name: 'raw.json', has_spec: true } });
  assert.equal(normalizeGenerateDraft({ source: { raw_name: 'x' } }).source, null);
  let value = '';
  const storage = { getItem: () => value, setItem: (_, v) => { value = v; } };
  assert.equal(saveGenerateDraft(storage, saved), true);
  assert.deepEqual(readGenerateDraft(storage), saved);
  value = '{broken';
  assert.deepEqual(readGenerateDraft(storage), normalizeGenerateDraft(null));
  assert.equal(saveGenerateDraft({ setItem() { throw new Error('quota'); } }, saved), false);
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

test('Export retains saved evaluation and the exact prompt without copying raw inputs', () => {
  const a = bundle([row('r1')]);
  a.job.review = { decision: 'shortlisted', notes: 'Clear.' };
  const result = experimentReport([a], 'fixed-time');
  assert.equal(result.created_at, 'fixed-time');
  assert.equal(result.runs[0].prompt_text, a.inputs.prompt_text);
  assert.deepEqual(result.runs[0].review, a.job.review);
  assert.equal('data' in result.runs[0], false);
});

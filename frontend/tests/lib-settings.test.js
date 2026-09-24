// lib/settings.js: 폼 값 ↔ MTurk 구조 변환, 검증, agent settings.json 반영, 게시 요청. 기대값은 prototype/src/features/create/settings.test.ts 에서 왔다.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_SETTINGS,
  applyJobSettings,
  balanceCentsOf,
  buildCreateBatchRequest,
  buildQualificationRequirements,
  defaultSettings,
  describeQualifications,
  describeReferenceCell,
  estimateFor,
  normalizeCountries,
  toAttentionRule,
  toHitSettings,
  toReviewReference,
  validateSettings,
} from '../src/lib/settings.js';

describe('defaults', () => {
  it('프로토타입과 같은 기본값이고, defaultSettings 는 배열을 공유하지 않는다', () => {
    assert.equal(DEFAULT_SETTINGS.Title, 'Sentence and passage relevance quiz');
    assert.equal(DEFAULT_SETTINGS.Reward, '0.10');
    assert.equal(DEFAULT_SETTINGS.MaxAssignments, 3);
    assert.equal(DEFAULT_SETTINGS.approvalRate, 95);
    assert.equal(DEFAULT_SETTINGS.approvedHits, 1000);
    assert.deepEqual(DEFAULT_SETTINGS.countries, ['US']);
    assert.equal(DEFAULT_SETTINGS.attentionEnabled, false);
    assert.equal(DEFAULT_SETTINGS.attentionPrefix, 'attention_');
    assert.equal(DEFAULT_SETTINGS.referenceColumn, null);
    const a = defaultSettings();
    a.countries.push('KR');
    assert.deepEqual(defaultSettings().countries, ['US']);
  });
});

describe('toHitSettings', () => {
  it('converts the case-study defaults to MTurk units', () => {
    assert.deepEqual(toHitSettings(DEFAULT_SETTINGS), {
      Title: 'Sentence and passage relevance quiz',
      Description: 'Read a sentence and a passage, then assess their relevance.',
      Keywords: 'English, Reading, Sentence, Passage, Quiz',
      Reward: '0.10',
      MaxAssignments: 3,
      AssignmentDurationInSeconds: 30 * 60,
      LifetimeInSeconds: 30 * 24 * 3600,
      AutoApprovalDelayInSeconds: 30 * 24 * 3600,
      QualificationRequirements: [],
    });
  });

  it('normalizes the reward to two decimals and trims text', () => {
    const settings = toHitSettings({ ...DEFAULT_SETTINGS, Reward: '0.2', Title: '  Quiz  ' });
    assert.equal(settings.Reward, '0.20');
    assert.equal(settings.Title, 'Quiz');
  });
});

describe('buildQualificationRequirements', () => {
  it('maps the three form rows to the MTurk system qualifications', () => {
    const requirements = buildQualificationRequirements({
      ...DEFAULT_SETTINGS,
      approvalRateEnabled: true,
      approvalRate: 98,
      approvedHitsEnabled: true,
      approvedHits: 500,
      countriesEnabled: true,
      countries: ['US', 'CA'],
    });
    assert.deepEqual(requirements, [
      { QualificationTypeId: '000000000000000000L0', Comparator: 'GreaterThanOrEqualTo', IntegerValues: [98] },
      { QualificationTypeId: '00000000000000000040', Comparator: 'GreaterThanOrEqualTo', IntegerValues: [500] },
      { QualificationTypeId: '00000000000000000071', Comparator: 'In', LocaleValues: [{ Country: 'US' }, { Country: 'CA' }] },
    ]);
  });

  it('ignores rows that are switched off, whatever value they hold', () => {
    assert.deepEqual(buildQualificationRequirements({ ...DEFAULT_SETTINGS, approvalRate: 99, countries: ['KR'] }), []);
  });
});

describe('toAttentionRule', () => {
  it('is null when the template has no attention checks', () => {
    assert.equal(toAttentionRule({ ...DEFAULT_SETTINGS, attentionExpected: 'not_grounded' }), null);
  });

  it('builds the rule when switched on', () => {
    assert.deepEqual(toAttentionRule({ ...DEFAULT_SETTINGS, attentionEnabled: true, attentionExpected: 'not_grounded' }), {
      namePrefix: 'attention_',
      expectedValue: 'not_grounded',
      minCorrectRatio: 1,
    });
  });
});

describe('toReviewReference', () => {
  it('defaults to the majority of the other workers', () => {
    assert.deepEqual(toReviewReference(DEFAULT_SETTINGS), { source: 'majority' });
    assert.deepEqual(toReviewReference({ ...DEFAULT_SETTINGS, referenceColumn: '' }), { source: 'majority' });
    assert.deepEqual(toReviewReference({ ...DEFAULT_SETTINGS, referenceColumn: '  ' }), { source: 'majority' });
  });

  it('points at the chosen CSV column', () => {
    assert.deepEqual(toReviewReference({ ...DEFAULT_SETTINGS, referenceColumn: 'query_fact_coverage_check' }), {
      source: 'column',
      column: 'query_fact_coverage_check',
    });
  });
});

describe('describeReferenceCell', () => {
  it('tells the shape of the first cell: object, list or single value', () => {
    assert.deepEqual(describeReferenceCell("{'general_0_1': 'Covered', 'general_1_1': 'Not covered'}"), {
      type: 'info',
      message: 'Row 1 reads as an object with 2 entries (matched to answers by name).',
    });
    assert.deepEqual(describeReferenceCell('["grounded", "grounded", "not_grounded"]'), {
      type: 'info',
      message: 'Row 1 reads as a list of 3 values (matched to answers by position).',
    });
    assert.deepEqual(describeReferenceCell('grounded'), {
      type: 'info',
      message: 'Row 1 reads as a single value "grounded" (used when the task has exactly one answer besides attention items).',
    });
    assert.deepEqual(describeReferenceCell('"grounded"'), {
      type: 'info',
      message: 'Row 1 reads as a single value "grounded" (used when the task has exactly one answer besides attention items).',
    });
  });

  it('shortens a long single value and warns on an empty or null cell', () => {
    const long = 'x'.repeat(60);
    assert.ok(describeReferenceCell(long).message.includes(`"${'x'.repeat(40)}…"`));
    assert.deepEqual(describeReferenceCell('   '), { type: 'warning', message: 'Row 1 is empty; answers in that row will show no reference.' });
    assert.deepEqual(describeReferenceCell('None'), { type: 'warning', message: 'Row 1 reads as null; answers in that row will show no reference.' });
  });
});

describe('estimateFor', () => {
  it('matches the example: 160 HITs x 3 x $0.10 = $48.00 + $9.60', () => {
    assert.deepEqual(estimateFor(DEFAULT_SETTINGS, 160), { rewardCents: 4800, feeCents: 960, totalCents: 5760, feePercent: 20 });
  });

  it('returns null instead of throwing on a broken reward', () => {
    assert.equal(estimateFor({ ...DEFAULT_SETTINGS, Reward: '' }, 10), null);
  });
});

describe('helpers', () => {
  it('normalizes typed country codes from an array or a comma/space separated string', () => {
    assert.deepEqual(normalizeCountries([' us', 'US', 'gb ', '']), ['US', 'GB']);
    assert.deepEqual(normalizeCountries('us, ca gb,,'), ['US', 'CA', 'GB']);
  });

  it('reads the balance in cents', () => {
    assert.equal(balanceCentsOf({ env: 'mock', AvailableBalance: '500.00' }), 50000);
    assert.equal(balanceCentsOf(undefined), null);
    assert.equal(balanceCentsOf({ env: 'mock', AvailableBalance: 'n/a' }), null);
  });

  it('describes the qualifications for the Publish summary', () => {
    assert.deepEqual(describeQualifications(DEFAULT_SETTINGS), []);
    assert.deepEqual(
      describeQualifications({ ...DEFAULT_SETTINGS, approvalRateEnabled: true, approvedHitsEnabled: true, countriesEnabled: true, countries: ['US', 'KR'] }),
      ['HIT approval rate ≥ 95%', 'Approved HITs ≥ 1,000', 'Location in US, KR'],
    );
  });
});

describe('validateSettings', () => {
  const columns = ['item_id', 'passage'];

  it('passes the defaults', () => {
    assert.deepEqual(validateSettings(DEFAULT_SETTINGS, { columns }), {});
  });

  it('reports every broken required field with the prototype messages', () => {
    const errors = validateSettings(
      {
        ...DEFAULT_SETTINGS,
        Title: '  ',
        Description: '',
        Reward: '0.001',
        MaxAssignments: 0,
        durationMinutes: 0,
        lifetimeDays: 0,
        autoApprovalDays: 31,
      },
      { columns },
    );
    assert.deepEqual(errors, {
      Title: 'Enter a title.',
      Description: 'Enter a description.',
      Reward: 'The minimum reward is $0.01.',
      MaxAssignments: 'Enter a whole number, 1 or more.',
      durationMinutes: 'Enter at least 1 minute.',
      lifetimeDays: 'Enter at least 1 day.',
      autoApprovalDays: 'Enter 1 to 30 days.',
    });
    assert.equal(validateSettings({ ...DEFAULT_SETTINGS, Reward: '' }).Reward, 'Enter a reward.');
    assert.equal(validateSettings({ ...DEFAULT_SETTINGS, MaxAssignments: 2.5 }).MaxAssignments, 'Enter a whole number, 1 or more.');
  });

  it('checks qualification values only when the row is enabled', () => {
    assert.deepEqual(validateSettings({ ...DEFAULT_SETTINGS, approvalRate: 500, approvedHits: -1, countries: [] }), {});
    const errors = validateSettings({
      ...DEFAULT_SETTINGS,
      approvalRateEnabled: true,
      approvalRate: 101,
      approvedHitsEnabled: true,
      approvedHits: -1,
      countriesEnabled: true,
      countries: [],
    });
    assert.deepEqual(errors, { approvalRate: 'Enter 0 to 100.', approvedHits: 'Enter 0 or more.', countries: 'Choose at least one country.' });
    assert.equal(
      validateSettings({ ...DEFAULT_SETTINGS, countriesEnabled: true, countries: ['US', 'USA', 'k'] }).countries,
      'Use two-letter country codes (ISO 3166). Not valid: USA, k',
    );
  });

  it('rejects a pool that is both required and excluded, naming it', () => {
    const pools = [{ id: 'pool-1', name: 'Trusted' }];
    const errors = validateSettings({ ...DEFAULT_SETTINGS, requiredPoolIds: ['pool-1'], excludedPoolIds: ['pool-1', 'pool-2'] }, { pools });
    assert.equal(errors.excludedPoolIds, 'A pool cannot be both required and excluded: Trusted');
  });

  it('checks the attention rule only when it is switched on', () => {
    assert.deepEqual(validateSettings({ ...DEFAULT_SETTINGS, attentionExpected: '' }), {});
    const errors = validateSettings({ ...DEFAULT_SETTINGS, attentionEnabled: true, attentionPrefix: ' ', attentionExpected: '', attentionMinRatio: 1.5 });
    assert.deepEqual(errors, {
      attentionPrefix: 'Enter the prefix.',
      attentionExpected: 'Enter the expected value, e.g. not_grounded.',
      attentionMinRatio: 'Enter a value from 0 to 1.',
    });
  });

  it('rejects a reference column that is no longer in the CSV', () => {
    assert.deepEqual(validateSettings({ ...DEFAULT_SETTINGS, referenceColumn: 'passage' }, { columns }), {});
    assert.equal(
      validateSettings({ ...DEFAULT_SETTINGS, referenceColumn: 'llm_label' }, { columns }).referenceColumn,
      'Column "llm_label" is not in the uploaded CSV. Choose another column or the majority.',
    );
  });
});

describe('applyJobSettings (agent settings.json)', () => {
  const json = {
    Title: 'Judge whether each statement is supported by a passage',
    Description: 'Read one passage and decide, for each short statement, whether the passage supports it.',
    Keywords: 'reading, fact checking, english',
    attentionRule: { namePrefix: 'attention_', expectedValue: 'not_grounded', minCorrectRatio: 1 },
    reference: { source: 'column', column: 'llm_label' },
    referenceColumn: 'llm_label',
    reasonColumn: 'llm_reason',
    answerNames: { pattern: 'general_{i}_{j}{suffix}' },
    itemsPerHit: 4,
    attentionPerHit: 1,
    optionValues: ['grounded', 'not_grounded'],
  };
  const columns = ['hit_id', 'passage', 'facts', 'llm_label', 'llm_reason'];

  it('fills title, description, keywords, the attention rule and the reference column', () => {
    const values = applyJobSettings(defaultSettings(), json, columns);
    assert.equal(values.Title, json.Title);
    assert.equal(values.Description, json.Description);
    assert.equal(values.Keywords, json.Keywords);
    assert.equal(values.attentionEnabled, true);
    assert.equal(values.attentionPrefix, 'attention_');
    assert.equal(values.attentionExpected, 'not_grounded');
    assert.equal(values.attentionMinRatio, 1);
    assert.equal(values.referenceColumn, 'llm_label');
    // 없는 키는 기본값 그대로다
    assert.equal(values.Reward, '0.10');
    assert.equal(values.MaxAssignments, 3);
    assert.equal(values.durationMinutes, 30);
    assert.deepEqual(validateSettings(values, { columns }), {});
  });

  it('keeps majority when the reference column is not in the CSV, and switches attention off for a null rule', () => {
    const values = applyJobSettings(defaultSettings(), { ...json, attentionRule: null }, ['hit_id']);
    assert.equal(values.referenceColumn, null);
    assert.equal(values.attentionEnabled, false);
  });

  it('converts MTurk units when the file carries them', () => {
    const values = applyJobSettings(defaultSettings(), {
      Reward: '0.2',
      MaxAssignments: 5,
      AssignmentDurationInSeconds: 1200,
      LifetimeInSeconds: 7 * 86400,
      AutoApprovalDelayInSeconds: 60 * 86400,
    });
    assert.equal(values.Reward, '0.20');
    assert.equal(values.MaxAssignments, 5);
    assert.equal(values.durationMinutes, 20);
    assert.equal(values.lifetimeDays, 7);
    assert.equal(values.autoApprovalDays, 30); // MTurk 상한
  });

  it('ignores a value that is not an object', () => {
    assert.deepEqual(applyJobSettings(DEFAULT_SETTINGS, null), { ...DEFAULT_SETTINGS });
  });
});

describe('buildCreateBatchRequest', () => {
  const template = { id: 'tpl-1', name: 'T', html: '', placeholders: [] };
  const data = { fileName: 'data.csv', columns: ['a'], rows: [{ a: '1' }], hadBom: false, warnings: [] };

  it('assembles the CreateBatchRequest and omits an empty answerSchema', () => {
    const request = buildCreateBatchRequest({
      name: ' pilot ',
      template,
      data,
      settings: { ...DEFAULT_SETTINGS, attentionEnabled: true, attentionExpected: 'x', referenceColumn: 'a', requiredPoolIds: ['p1'] },
    });
    assert.deepEqual(request, {
      name: 'pilot',
      templateId: 'tpl-1',
      rows: [{ a: '1' }],
      inputColumns: ['a'],
      settings: toHitSettings(DEFAULT_SETTINGS),
      attentionRule: { namePrefix: 'attention_', expectedValue: 'x', minCorrectRatio: 1 },
      reference: { source: 'column', column: 'a' },
      requiredPoolIds: ['p1'],
      excludedPoolIds: [],
    });
    assert.ok(!('answerSchema' in request));
  });

  it('includes the answer schema when the preview reported one', () => {
    const answerSchema = [{ name: 'general_1', values: ['grounded', 'not_grounded'] }];
    const request = buildCreateBatchRequest({ name: 'n', template, data, settings: DEFAULT_SETTINGS, answerSchema });
    assert.deepEqual(request.answerSchema, answerSchema);
    assert.deepEqual(request.reference, { source: 'majority' });
    assert.equal(request.attentionRule, null);
  });
});

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
  describeAttentionCell,
  describeQualifications,
  describeReferenceCell,
  estimateFor,
  normalizeCountries,
  normalizeSuffixes,
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
    assert.equal(DEFAULT_SETTINGS.attentionMode, 'prefix');
    assert.equal(DEFAULT_SETTINGS.attentionColumn, null);
    assert.deepEqual(DEFAULT_SETTINGS.freeTextSuffixes, []);
    const a = defaultSettings();
    a.countries.push('KR');
    a.freeTextSuffixes.push('_note');
    assert.deepEqual(defaultSettings().countries, ['US']);
    assert.deepEqual(defaultSettings().freeTextSuffixes, []);
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

  it('builds the column shape in the expected answers column mode, ignoring the prefix fields', () => {
    const values = { ...DEFAULT_SETTINGS, attentionEnabled: true, attentionMode: 'column', attentionColumn: 'attention_expected', attentionExpected: 'x', attentionMinRatio: 0.5 };
    assert.deepEqual(toAttentionRule(values), { column: 'attention_expected', minCorrectRatio: 0.5 });
    assert.equal(toAttentionRule({ ...values, attentionEnabled: false }), null);
  });
});

describe('normalizeSuffixes', () => {
  it('splits a comma or space separated string, trims, and drops empties and duplicates', () => {
    assert.deepEqual(normalizeSuffixes(' _missing_info, _comment _missing_info,, '), ['_missing_info', '_comment']);
    assert.deepEqual(normalizeSuffixes(['_note', ' _note ', '', 3]), ['_note']);
    assert.deepEqual(normalizeSuffixes(''), []);
    assert.deepEqual(normalizeSuffixes(undefined), []);
  });
});

describe('describeAttentionCell', () => {
  it('lists the expected answers of the first row, or warns that the HIT has no attention check', () => {
    assert.deepEqual(describeAttentionCell('{"general_1_1_support": "not_supported"}'), {
      type: 'info',
      message: 'Row 1 expects 1 attention answer(s): general_1_1_support = not_supported.',
    });
    assert.deepEqual(describeAttentionCell("{'a': 'x', 'b': 2, 'c': 'z', 'd': 'w'}"), { type: 'info', message: 'Row 1 expects 4 attention answer(s): a = x, b = 2, c = z, and 1 more.' });
    assert.deepEqual(describeAttentionCell(''), { type: 'warning', message: 'Row 1 is empty, so that HIT has no attention check.' });
    assert.deepEqual(describeAttentionCell('{}'), { type: 'warning', message: 'Row 1 lists no answers, so that HIT has no attention check.' });
    assert.deepEqual(describeAttentionCell('not_grounded'), { type: 'warning', message: 'Row 1 is not an object of {answer name: expected value}, so that HIT has no attention check.' });
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

  it('checks the expected answers column instead of the prefix fields in column mode', () => {
    const on = { ...DEFAULT_SETTINGS, attentionEnabled: true, attentionMode: 'column', attentionPrefix: '', attentionExpected: '' };
    assert.deepEqual(validateSettings({ ...on, attentionColumn: 'passage' }, { columns }), {});
    assert.deepEqual(validateSettings({ ...on, attentionColumn: null }, { columns }), { attentionColumn: 'Choose the CSV column that holds the expected answers.' });
    assert.deepEqual(validateSettings({ ...on, attentionColumn: 'attention_expected', attentionMinRatio: -1 }, { columns }), {
      attentionColumn: 'Column "attention_expected" is not in the uploaded CSV. Choose another column.',
      attentionMinRatio: 'Enter a value from 0 to 1.',
    });
    assert.deepEqual(validateSettings({ ...on, attentionEnabled: false, attentionColumn: 'nope' }, { columns }), {});
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

describe('applyJobSettings (settings.json with an expected answers column)', () => {
  // agent 의 새 출력 (문항 여러 개, 숨긴 attention, 자유 서술 답)
  const json = {
    Title: 'Judge which statements a passage supports',
    Description: 'Read a passage and mark the statements it supports.',
    Keywords: 'a, b',
    attentionRule: { column: 'attention_expected', minCorrectRatio: 1 },
    reference: { source: 'column', column: 'llm_label' },
    referenceColumn: 'llm_label',
    reasonColumn: 'llm_reason',
    freeTextSuffixes: ['_missing_info'],
    questions: [{ id: 'support', type: 'multi_select', scope: 'target', values: ['supported', 'not_supported'] }],
    answerNames: { target: 'general_{i}_{j}_{qid}', item: 'general_{i}_{qid}' },
    itemsPerHit: 10,
    attentionPerHit: 1,
    optionValues: ['supported', 'not_supported'],
  };
  const columns = ['hit_id', 'record_ids', 'item_ids', 'attention', 'passage', 'statements', 'llm_label', 'llm_reason', 'attention_expected'];

  it('switches to the column mode, picks the column and reads the free-text suffixes', () => {
    const values = applyJobSettings(defaultSettings(), json, columns);
    assert.equal(values.Title, json.Title);
    assert.equal(values.attentionEnabled, true);
    assert.equal(values.attentionMode, 'column');
    assert.equal(values.attentionColumn, 'attention_expected');
    assert.equal(values.attentionMinRatio, 1);
    assert.equal(values.attentionPrefix, 'attention_'); // prefix 방식의 값은 그대로 둔다
    assert.deepEqual(values.freeTextSuffixes, ['_missing_info']);
    assert.equal(values.referenceColumn, 'llm_label');
    assert.deepEqual(validateSettings(values, { columns }), {});
    assert.deepEqual(toAttentionRule(values), { column: 'attention_expected', minCorrectRatio: 1 });
  });

  it('keeps an attention column that the CSV lacks so that Next reports it', () => {
    const values = applyJobSettings(defaultSettings(), json, ['hit_id', 'llm_label']);
    assert.equal(values.attentionColumn, 'attention_expected');
    assert.equal(validateSettings(values, { columns: ['hit_id', 'llm_label'] }).attentionColumn, 'Column "attention_expected" is not in the uploaded CSV. Choose another column.');
  });

  it('switches back to the prefix mode for an old settings.json, and keeps the suffixes when the key is missing', () => {
    const column = applyJobSettings(defaultSettings(), json, columns);
    const old = applyJobSettings(column, { attentionRule: { namePrefix: 'check_', expectedValue: 'not_grounded', minCorrectRatio: 0.5 } }, columns);
    assert.equal(old.attentionMode, 'prefix');
    assert.equal(old.attentionPrefix, 'check_');
    assert.equal(old.attentionExpected, 'not_grounded');
    assert.equal(old.attentionMinRatio, 0.5);
    assert.deepEqual(old.freeTextSuffixes, ['_missing_info']);
    assert.deepEqual(applyJobSettings(column, { ...json, attentionRule: null, freeTextSuffixes: [] }, columns).freeTextSuffixes, []);
    assert.equal(applyJobSettings(column, { attentionRule: null }, columns).attentionEnabled, false);
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

  it('sends the column rule and the free-text suffixes', () => {
    const request = buildCreateBatchRequest({
      name: 'n',
      template,
      data: { ...data, columns: ['a', 'attention_expected'] },
      settings: { ...DEFAULT_SETTINGS, attentionEnabled: true, attentionMode: 'column', attentionColumn: 'attention_expected', freeTextSuffixes: ['_missing_info', ' '] },
    });
    assert.deepEqual(request.attentionRule, { column: 'attention_expected', minCorrectRatio: 1 });
    assert.deepEqual(request.freeTextSuffixes, ['_missing_info']);
    assert.ok(!('freeTextSuffixes' in buildCreateBatchRequest({ name: 'n', template, data, settings: DEFAULT_SETTINGS })));
  });

  it('includes the answer schema when the preview reported one', () => {
    const answerSchema = [{ name: 'general_1', values: ['grounded', 'not_grounded'] }];
    const request = buildCreateBatchRequest({ name: 'n', template, data, settings: DEFAULT_SETTINGS, answerSchema });
    assert.deepEqual(request.answerSchema, answerSchema);
    assert.deepEqual(request.reference, { source: 'majority' });
    assert.equal(request.attentionRule, null);
  });
});

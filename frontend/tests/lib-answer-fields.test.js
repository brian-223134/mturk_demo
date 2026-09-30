// lib/answer-fields.js: Preview 단계의 Answer fields 카드가 문항 목록을 Settings 의 attention 규칙, 자유 서술 접미어와 맞춰 보는 규칙.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { checkAnswerFields } from '../src/lib/answer-fields.js';
import { DEFAULT_SETTINGS } from '../src/lib/settings.js';

// 템플릿이 window.TASK_ANSWER_SCHEMA 로 밝힌 목록 (type 이 있다). 탭 0 은 일반, 탭 1 은 attention 이지만 이름으로는 구별되지 않는다
const DECLARED = [
  { name: 'general_0_1_support', values: ['supported', 'not_supported'], type: 'multi_select', required: true },
  { name: 'general_0_covered', values: ['Yes', 'No'], type: 'choice', required: true },
  { name: 'general_0_missing_info', values: [], type: 'text', required: false },
  { name: 'general_1_1_support', values: ['supported', 'not_supported'], type: 'multi_select', required: true },
];
const COLUMN = { ...DEFAULT_SETTINGS, attentionEnabled: true, attentionMode: 'column', attentionColumn: 'attention_expected', freeTextSuffixes: ['_missing_info'] };
const ROW = { hit_id: 'h0', attention_expected: '{"general_1_1_support": "not_supported"}' };

const names = (set) => [...set].sort();

describe('checkAnswerFields: column mode', () => {
  it('marks the keys of this row as attention and the suffix fields as free text, without warnings', () => {
    const result = checkAnswerFields(DECLARED, COLUMN, ROW);
    assert.deepEqual(names(result.attention), ['general_1_1_support']);
    assert.deepEqual(names(result.freeText), ['general_0_missing_info']);
    assert.deepEqual(result.warnings, []);
  });

  it('warns about expected answers that are not fields and values that are not choices', () => {
    const row = { attention_expected: "{'general_1_1_support': 'Not supported', 'general_9_x': 'a', 'general_0_missing_info': 'anything'}" };
    const result = checkAnswerFields(DECLARED, COLUMN, row);
    assert.deepEqual(names(result.attention), ['general_0_missing_info', 'general_1_1_support']);
    assert.deepEqual(names(result.freeText), []); // attention 이 먼저다 (text 필드라도 attention 이면 접미어 경고도 없다)
    assert.deepEqual(result.warnings, [
      '"attention_expected" expects answers that are not among the fields: general_9_x.',
      'The expected value "Not supported" of general_1_1_support is not one of its choices (supported, not_supported).',
    ]);
  });

  it('warns when the cell of this row is empty or not an object', () => {
    assert.deepEqual(checkAnswerFields(DECLARED, COLUMN, { attention_expected: '{}' }).warnings, ['The "attention_expected" cell of this row lists no answers, so this HIT has no attention check.']);
    for (const cell of ['', 'not_supported', '["a"]']) {
      const result = checkAnswerFields(DECLARED, COLUMN, { attention_expected: cell });
      assert.equal(result.attention.size, 0);
      assert.deepEqual(result.warnings, ['The "attention_expected" cell of this row is not an object of {answer name: expected value}, so this HIT has no attention check.']);
    }
  });
});

describe('checkAnswerFields: prefix mode (the old templates)', () => {
  const scanned = [
    { name: 'general_0_1', values: ['grounded', 'not_grounded'] },
    { name: 'attention_1_1', values: ['grounded', 'not_grounded'] },
  ];
  const prefix = { ...DEFAULT_SETTINGS, attentionEnabled: true, attentionExpected: 'not_grounded' };

  it('finds attention fields by name and checks the expected value against their choices', () => {
    const result = checkAnswerFields(scanned, prefix);
    assert.deepEqual(names(result.attention), ['attention_1_1']);
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(checkAnswerFields(scanned, { ...prefix, attentionExpected: 'Not Grounded' }).warnings, ['"Not Grounded" is not one of the choices of attention_1_1 (grounded, not_grounded).']);
    assert.deepEqual(checkAnswerFields(scanned, { ...prefix, attentionPrefix: 'check_' }).warnings, ['No field name starts with "check_". Check the attention rule in Settings.']);
  });

  it('checks nothing about attention when the rule is off', () => {
    const result = checkAnswerFields(scanned, DEFAULT_SETTINGS);
    assert.equal(result.attention.size, 0);
    assert.deepEqual(result.warnings, []);
  });

  it('does not check free text against a scanned list (it has no text fields and no types)', () => {
    const result = checkAnswerFields(scanned, { ...DEFAULT_SETTINGS, freeTextSuffixes: ['_comment'] });
    assert.deepEqual(result.warnings, []);
  });
});

describe('checkAnswerFields: free-text suffixes against a declared schema', () => {
  it('warns about text fields without a suffix, suffix fields that are not text, and suffixes that match nothing', () => {
    const settings = { ...DEFAULT_SETTINGS, freeTextSuffixes: ['_covered', '_comment'] };
    const result = checkAnswerFields(DECLARED, settings);
    assert.deepEqual(names(result.freeText), ['general_0_covered']);
    assert.deepEqual(result.warnings, [
      'Text field(s) not matched by the free-text suffixes: general_0_missing_info. Their text would count as labels in κ and agreement.',
      'Field(s) ending with a free-text suffix are not text fields: general_0_covered. They would be left out of κ and agreement.',
      'No field name ends with the free-text suffix "_comment".',
    ]);
  });
});

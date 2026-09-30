// pages/manage/shared.js 의 answerKindsOf 와 answerTokens.js 의 freeTextPreview: Review 가 attention 답과 자유 서술 답을 가리는 규칙.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EMPTY_TOKEN, FREE_TEXT_PREVIEW, freeTextPreview } from '../src/pages/manage/answerTokens.js';
import { answerKindsOf } from '../src/pages/manage/shared.js';

describe('answerKindsOf', () => {
  const columnBatch = { attentionRule: { column: 'attention_expected', minCorrectRatio: 1 }, freeTextSuffixes: ['_missing_info'] };

  it('uses attentionNames and freeTextNames from listAssignments when they are there', () => {
    const kinds = answerKindsOf({ attentionNames: ['general_1_1_support'], freeTextNames: ['general_2_missing_info'] }, columnBatch);
    assert.equal(kinds.isAttention('general_1_1_support'), true);
    assert.equal(kinds.isAttention('attention_1'), false); // 컬럼 방식에서는 이름이 attention_ 로 시작해도 아니다
    assert.equal(kinds.isFreeText('general_2_missing_info'), true);
    assert.equal(kinds.isFreeText('general_3_missing_info'), false); // 서버가 준 목록이 기준이다
  });

  it('falls back to the prefix and the batch suffixes for a server without the lists', () => {
    const legacy = answerKindsOf({}, { attentionRule: { namePrefix: 'check_', expectedValue: 'x' }, freeTextSuffixes: ['_comment'] });
    assert.equal(legacy.isAttention('check_1'), true);
    assert.equal(legacy.isAttention('attention_1'), false);
    assert.equal(legacy.isFreeText('general_0_comment'), true);
    assert.equal(legacy.isFreeText('check_0_comment'), false); // attention 이 먼저다
    const none = answerKindsOf({}, { attentionRule: null });
    assert.equal(none.isAttention('attention_3_1'), true);
    assert.equal(none.isFreeText('general_0_comment'), false);
  });
});

describe('freeTextPreview', () => {
  it('collapses white space and cuts long text with an ellipsis', () => {
    assert.equal(freeTextPreview('  The year\n is   missing. '), 'The year is missing.');
    const long = 'x'.repeat(FREE_TEXT_PREVIEW + 5);
    assert.equal(freeTextPreview(long), `${'x'.repeat(FREE_TEXT_PREVIEW - 1)}…`);
    assert.equal(freeTextPreview(long).length, FREE_TEXT_PREVIEW);
    assert.equal(freeTextPreview('abcdef', 4), 'abc…');
  });

  it('shows an empty answer as the empty token', () => {
    assert.equal(freeTextPreview('  '), EMPTY_TOKEN);
    assert.equal(freeTextPreview(undefined), EMPTY_TOKEN);
  });
});

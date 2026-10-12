// lib/layout-lint.js 검사. Design Layout 이 편집 중인 HTML 에서 찾아 알리는 문제들.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { hasLayoutErrors, lintLayout, parseAttributes, scanTags } from '../src/lib/layout-lint.js';

const SCRIPT = '<script src="/elements/ann-elements.js"></script>';
const messages = (result, level) => result.problems.filter((p) => !level || p.level === level).map((p) => p.message);

describe('scanTags / parseAttributes', () => {
  it('따옴표 안의 > 와 속성 모양을 읽는다', () => {
    assert.deepEqual(parseAttributes(' name="a" required options=\'x, y\' rows=3'), { name: 'a', required: '', options: 'x, y', rows: '3' });
    const tags = scanTags('<ann-choice header="a > b" name="q"><ann-option value="x">X</ann-option></ann-choice>');
    assert.deepEqual(tags.map((t) => `${t.closing ? '/' : ''}${t.name}`), ['ann-choice', 'ann-option', '/ann-option', '/ann-choice']);
    assert.equal(tags[0].attributes.header, 'a > b');
  });
  it('주석과 script 본문의 태그 모양은 무시한다', () => {
    const tags = scanTags('<!-- <ann-choice> --><script>var s = "<ann-likert>";</script><p>x</p>');
    assert.deepEqual(tags.map((t) => t.name), ['script', 'script', 'p', 'p']);
  });
});

describe('lintLayout', () => {
  it('올바른 layout 은 오류가 없고 문항과 placeholder 를 돌려준다', () => {
    const result = lintLayout(`${SCRIPT}<ann-form><ann-text>\${passage}</ann-text><ann-choice name="relevance" required><ann-option value="a">A</ann-option><ann-option value="b">B</ann-option></ann-choice><ann-textarea name="comment"></ann-textarea></ann-form>`);
    assert.equal(result.kind, 'ann');
    assert.deepEqual(result.placeholders, ['passage']);
    assert.deepEqual(result.questions, [{ tag: 'ann-choice', name: 'relevance' }, { tag: 'ann-textarea', name: 'comment' }]);
    assert.deepEqual(result.problems, []);
    assert.equal(hasLayoutErrors(result), false);
  });

  it('script 가 없으면 오류다', () => {
    const result = lintLayout('<ann-form><ann-choice name="q" options="a, b"></ann-choice></ann-form>');
    assert.match(messages(result, 'error')[0], /ann-elements\.js/);
    assert.ok(hasLayoutErrors(result));
  });

  it('이름이 없거나 겹치면 오류, 선택지가 없으면 오류', () => {
    const result = lintLayout(`${SCRIPT}<ann-form><ann-choice name="q" options="a, b"></ann-choice><ann-choice name="q"></ann-choice><ann-likert></ann-likert></ann-form>`);
    const errors = messages(result, 'error');
    assert.ok(errors.some((m) => m.includes('<ann-choice name="q"> has no options')));
    assert.ok(errors.some((m) => m.includes('<ann-likert> #1 has no name')));
    assert.ok(errors.some((m) => m.includes('"q" is used by 2 questions')));
  });

  it('ann-form 밖의 문항, 모르는 요소, likert 범위', () => {
    const result = lintLayout(`${SCRIPT}<ann-choise name="x"></ann-choise><ann-likert name="s" min="5" max="5"></ann-likert>`);
    assert.ok(messages(result, 'warning').some((m) => m.includes('Unknown element <ann-choise>')));
    assert.ok(messages(result, 'error').some((m) => m.includes('inside <ann-form>')));
    assert.ok(messages(result, 'error').some((m) => m.includes('max must be')));
  });

  it('ann-form 이 있어도 그 밖에 둔 문항은 오류다', () => {
    const result = lintLayout(`${SCRIPT}<ann-form><ann-choice name="a" options="x, y"></ann-choice></ann-form><ann-textarea name="comment"></ann-textarea>`);
    assert.deepEqual(messages(result, 'error'), ['<ann-textarea name="comment"> is outside <ann-form>. Move it inside the form, or the answers are not sent.']);
  });

  it('crowd-html-elements 템플릿은 crowd 로 보고 외부 스크립트를 알린다', () => {
    const result = lintLayout('<script src="https://assets.crowd.aws/crowd-html-elements.js"></script><crowd-form><p>${passage}</p></crowd-form>');
    assert.equal(result.kind, 'crowd');
    assert.equal(hasLayoutErrors(result), false);
    assert.match(messages(result, 'info')[0], /assets\.crowd\.aws/);
  });

  it('빈 layout 은 오류다', () => {
    assert.equal(lintLayout('  ').kind, 'empty');
    assert.ok(hasLayoutErrors(lintLayout('')));
  });
});

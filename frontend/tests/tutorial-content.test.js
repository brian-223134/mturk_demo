// pages/create/tutorial-content.js: Tutorial 의 한국어와 영어가 같은 구조인지, 화면 글자와 코드가 같은지, 언어 고르기.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { describe, it } from 'node:test';

import { DEFAULT_LANGUAGE, LANGUAGES, TUTORIAL, tutorialLanguage } from '../src/pages/create/tutorial-content.js';

const kinds = (block) => Object.keys(block).sort().join(',');
/** 글 조각에서 표시 토큰을 모은다. */
function tokens(parts) {
  return parts.filter((part) => typeof part === 'object').map((part) => (part.ui !== undefined ? `ui:${part.ui}` : part.code !== undefined ? `code:${part.code}` : 'strong')).sort();
}
function blockTokens(block) {
  if (block.p) return [tokens(block.p)];
  if (block.note) return [tokens(block.note)];
  if (block.steps) return block.steps.map(tokens);
  if (block.faq) return block.faq.map((entry) => tokens(entry.a));
  if (block.table) return [...block.table.head, ...block.table.rows.flat()].map(tokens);
  return [];
}
const allStrings = (value) => (typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(allStrings) : value && typeof value === 'object' ? Object.values(value).flatMap(allStrings) : []);

describe('Tutorial 문구', () => {
  const { ko, en } = TUTORIAL;

  it('언어 목록과 내용이 맞는다', () => {
    assert.deepEqual(LANGUAGES.map((l) => l.value).sort(), Object.keys(TUTORIAL).sort());
    assert.deepEqual(LANGUAGES.map((l) => l.label), ['KR', 'EN']);
  });

  it('두 언어의 절과 블록 구조가 같다', () => {
    assert.deepEqual(en.sections.map((s) => s.id), ko.sections.map((s) => s.id));
    assert.equal(new Set(ko.sections.map((s) => s.id)).size, ko.sections.length);
    ko.sections.forEach((section, index) => {
      const other = en.sections[index];
      assert.deepEqual(other.blocks.map(kinds), section.blocks.map(kinds), section.id);
      section.blocks.forEach((block, at) => {
        if (block.steps) assert.equal(other.blocks[at].steps.length, block.steps.length, section.id);
        if (block.faq) assert.equal(other.blocks[at].faq.length, block.faq.length, section.id);
        if (block.flow) assert.equal(other.blocks[at].flow.length, block.flow.length, section.id);
        if (block.table) assert.equal(other.blocks[at].table.rows.length, block.table.rows.length, section.id);
        if (block.actions) {
          const targets = (list) => list.map((a) => a.download ?? a.open ?? a.gallery);
          assert.deepEqual(targets(other.blocks[at].actions), targets(block.actions), section.id);
        }
      });
    });
  });

  it('화면 글자와 코드는 두 언어에서 같다', () => {
    ko.sections.forEach((section, index) => {
      section.blocks.forEach((block, at) => {
        assert.deepEqual(blockTokens(en.sections[index].blocks[at]), blockTokens(block), `${section.id} block ${at}`);
      });
    });
  });

  it('영어판에 한글이 없다', () => {
    for (const text of allStrings(en)) assert.equal(/\p{Script=Hangul}/u.test(text), false, text);
  });

  it('내려받기 파일이 저장소에 있다', () => {
    const files = ko.sections.flatMap((s) => s.blocks.flatMap((b) => b.actions ?? [])).filter((a) => a.download);
    assert.ok(files.length >= 3);
    for (const file of files) assert.ok(existsSync(new URL(`../..${file.download}`, import.meta.url)), file.download);
  });

  it('지금 기본 흐름을 설명하고 예전 표현이 남아 있지 않다', () => {
    assert.ok(ko.sections.some((s) => s.id === 'tutorial-design'));
    const text = allStrings(ko).join('\n');
    for (const old of ['Upload CSV', 'CSV를 올', '한 행 = HIT']) assert.equal(text.includes(old), false, old);
  });
});

describe('tutorialLanguage', () => {
  it('주소 → 저장한 값 → 기본 순서이고 모르는 값은 건너뛴다', () => {
    assert.equal(tutorialLanguage('?lang=en', 'ko'), 'en');
    assert.equal(tutorialLanguage('', 'en'), 'en');
    assert.equal(tutorialLanguage('', null), DEFAULT_LANGUAGE);
    assert.equal(tutorialLanguage('?lang=fr', 'en'), 'en');
    assert.equal(tutorialLanguage('?lang=fr', 'de'), 'ko');
    assert.equal(tutorialLanguage(undefined, undefined), 'ko');
  });
});

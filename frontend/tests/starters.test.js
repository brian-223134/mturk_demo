// starter 템플릿 검사 (lib/starters.js, elements/starters/*.html). New Project 갤러리에서 고른 템플릿이 바로 쓸 수 있는 상태인지 본다:
// 파일이 있고, layout 검사에 오류가 없고, 표본 행이 placeholder 를 모두 채우고, 미리 채우는 속성이 Settings 폼의 키다.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

import { hasLayoutErrors, lintLayout } from '../src/lib/layout-lint.js';
import { DEFAULT_SETTINGS } from '../src/lib/settings.js';
import { STARTERS, STARTER_CATEGORIES, starterById, starterUrl } from '../src/lib/starters.js';

const DIR = new URL('../src/elements/starters/', import.meta.url);
const require = createRequire(import.meta.url);
const { core } = require('../src/elements/ann-elements.js');

describe('starters', () => {
  it('목록과 파일이 하나씩 맞는다', () => {
    const files = readdirSync(DIR).filter((name) => name.endsWith('.html')).sort();
    assert.deepEqual(STARTERS.map((s) => s.file).sort(), files);
    assert.equal(new Set(STARTERS.map((s) => s.id)).size, STARTERS.length);
    for (const starter of STARTERS) {
      assert.ok(STARTER_CATEGORIES.some((c) => c.key === starter.category), starter.id);
      assert.equal(starterById(starter.id), starter);
      assert.equal(starterUrl(starter), `/elements/starters/${starter.file}`);
    }
    assert.equal(starterById('nope'), null);
  });

  for (const starter of STARTERS) {
    describe(starter.id, () => {
      const html = readFileSync(new URL(starter.file, DIR), 'utf8');
      const result = lintLayout(html);

      it('ann 요소로 쓰였고 layout 검사에 오류와 경고가 없다', () => {
        assert.equal(result.kind, 'ann');
        assert.equal(hasLayoutErrors(result), false, JSON.stringify(result.problems));
        assert.deepEqual(result.problems.filter((p) => p.level === 'warning'), []);
        assert.ok(result.questions.length >= 1);
      });

      it('표본 행이 placeholder 를 모두 채우고, 남는 컬럼이 없다', () => {
        assert.deepEqual(Object.keys(starter.sampleRow).sort(), [...result.placeholders].sort());
        for (const value of Object.values(starter.sampleRow)) assert.equal(typeof value, 'string');
      });

      it('미리 채우는 속성은 Settings 폼의 키다', () => {
        for (const key of Object.keys(starter.properties)) assert.ok(key in DEFAULT_SETTINGS, key);
      });

      it('JSON 컬럼은 항목 목록으로 읽힌다', () => {
        for (const [column, value] of Object.entries(starter.sampleRow)) {
          if (!value.startsWith('[')) continue;
          assert.ok(html.includes(`<script type="application/json">\${${column}}</script>`), column);
          assert.ok(core.parseItems(value).length > 0);
        }
      });
    });
  }
});


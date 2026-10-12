// starter 템플릿 검사 (lib/starters.js, elements/starters/*.html). New Project 갤러리에서 고른 템플릿이 바로 쓸 수 있는 상태인지 본다:
// 파일이 있고, layout 검사에 오류가 없고, 표본 행이 placeholder 를 모두 채우고, 미리 채우는 속성이 Settings 폼의 키다.
// docs/create-projects.md 의 따라 하기가 쓰는 example/5-project 의 CSV 가 passage-relevance starter 와 맞는지도 본다.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

import { checkAnswerFields } from '../src/lib/answer-fields.js';
import { parseCsv } from '../src/lib/csv.js';
import { checkData } from '../src/lib/data-check.js';
import { hasLayoutErrors, lintLayout } from '../src/lib/layout-lint.js';
import { DEFAULT_SETTINGS, defaultSettings, validateQuality } from '../src/lib/settings.js';
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

describe('example/5-project/passage-relevance.csv with the passage-relevance starter', () => {
  const html = readFileSync(new URL('passage-relevance.html', DIR), 'utf8');
  const data = parseCsv(readFileSync(new URL('../../example/5-project/passage-relevance.csv', import.meta.url), 'utf8'), 'passage-relevance.csv');
  const { placeholders } = lintLayout(html);
  const schema = [{ name: 'relevance', type: 'choice', values: ['relevant', 'partially_relevant', 'not_relevant'], required: true }];
  const settings = { ...defaultSettings(), attentionEnabled: true, attentionMode: 'column', attentionColumn: 'attention_expected', referenceColumn: 'gold' };

  it('every column the layout reads is in the CSV; gold and attention_expected are extra', () => {
    const check = checkData(placeholders, data.columns, data.rows);
    assert.deepEqual(check.missingColumns, []);
    assert.deepEqual(check.unusedColumns, ['gold', 'attention_expected']);
    assert.equal(data.rows.length, 8);
  });

  it('two rows are attention checks whose expected answer is one of the choices', () => {
    const rows = data.rows.filter((row) => row.attention_expected !== '');
    assert.equal(rows.length, 2);
    for (const row of rows) {
      const { attention, warnings } = checkAnswerFields(schema, settings, row);
      assert.deepEqual([...attention], ['relevance']);
      assert.deepEqual(warnings, []);
    }
  });

  it('the gold column holds one of the choices on every row', () => {
    for (const row of data.rows) assert.ok(schema[0].values.includes(row.gold), row.gold);
    assert.deepEqual(validateQuality(settings, { columns: data.columns }), {});
  });
});

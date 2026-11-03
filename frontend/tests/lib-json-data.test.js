// lib/json-data.js: Publish Batch 가 올리는 HIT 데이터(JSON 배열) 읽기와 양식.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { checkData } from '../src/lib/data-check.js';
import { DataFileError, formatJsonTemplate, parseJsonData, readJsonDataFile } from '../src/lib/json-data.js';

describe('parseJsonData', () => {
  it('객체 하나가 HIT 하나이고 컬럼은 처음 나온 순서다', () => {
    const data = parseJsonData('[{"a": "x", "b": "y"}, {"c": "z", "a": "w"}]', 'd.json');
    assert.equal(data.fileName, 'd.json');
    assert.deepEqual(data.columns, ['a', 'b', 'c']);
    assert.deepEqual(data.rows, [{ a: 'x', b: 'y', c: '' }, { a: 'w', b: '', c: 'z' }]);
    assert.deepEqual(data.warnings, []);
    assert.equal(data.hadBom, false);
  });

  it('값은 모두 문자열이 되고, 배열과 객체는 JSON 글이 된다', () => {
    const { rows } = parseJsonData('[{"n": 3, "t": true, "z": null, "l": ["a", "b"], "o": {"q": "r"}, "s": "1"}]', 'd.json');
    assert.deepEqual(rows[0], { n: '3', t: 'true', z: '', l: '["a","b"]', o: '{"q":"r"}', s: '1' });
  });

  it('빠진 키는 빈 셀로 잡혀 data-check 가 경고한다', () => {
    const data = parseJsonData('[{"a": "x", "b": "y"}, {"a": "w"}]', 'd.json');
    const check = checkData(['a'], data.columns, data.rows);
    assert.deepEqual(check.missingColumns, []);
    assert.ok(check.rowsWithEmptyCells.length === 1);
  });

  it('BOM 을 떼고 알린다', () => {
    const data = parseJsonData('﻿[{"a": "x"}]', 'd.json');
    assert.equal(data.hadBom, true);
    assert.deepEqual(data.columns, ['a']);
  });

  it('쓸 수 없는 키는 버리고 알린다', () => {
    const data = parseJsonData('[{"a": "x", " ": "y", "__proto__": "z"}]', 'd.json');
    assert.deepEqual(data.columns, ['a']);
    assert.deepEqual(data.rows, [{ a: 'x' }]);
    assert.match(data.warnings[0], /^2 key\(s\)/);
    assert.equal({}.polluted, undefined);
  });

  it('모양이 다르면 이유를 말하며 거절한다', () => {
    const cases = [
      ['a,b\n1,2\n', /not valid JSON/], // CSV 를 올린 경우
      ['{"a": "x"}', /not an array/],
      ['[]', /array is empty/],
      ['[{"a": 1}, 2, "x"]', /^DataFileError: Item\(s\) 2, 3 are not objects/],
      ['[{}]', /no keys/],
    ];
    for (const [text, message] of cases) {
      assert.throws(() => parseJsonData(text, 'd.json'), DataFileError);
      assert.throws(() => parseJsonData(text, 'd.json'), message);
    }
  });
});

describe('readJsonDataFile', () => {
  it('파일 이름과 내용을 읽고, UTF-8 이 아니면 거절한다', async () => {
    const data = await readJsonDataFile(new File(['[{"a": "한글"}]'], 'k.json'));
    assert.equal(data.fileName, 'k.json');
    assert.equal(data.rows[0].a, '한글');
    await assert.rejects(readJsonDataFile(new Blob([new Uint8Array([0x5b, 0xc7, 0xd1, 0x5d])])), /not valid UTF-8/);
  });
});

describe('formatJsonTemplate', () => {
  it('JSON 글은 실제 배열과 객체로 보이고, 다시 읽으면 같은 행이 된다', () => {
    const sample = { text: 'a "quoted" line', items: '["x","y"]', expected: '{"q":"r"}', broken: '[not json' };
    const columns = ['text', 'items', 'expected', 'broken', 'empty'];
    const parsed = JSON.parse(formatJsonTemplate(columns, sample));
    assert.deepEqual(parsed, [{ text: 'a "quoted" line', items: ['x', 'y'], expected: { q: 'r' }, broken: '[not json', empty: '' }]);
    assert.deepEqual(parseJsonData(formatJsonTemplate(columns, sample), 't.json').rows, [{ ...sample, empty: '' }]);
  });
});

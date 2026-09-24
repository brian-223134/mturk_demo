// lib/csv.js 의 RFC 4180 파서와 UTF-8 검사. 기대값은 prototype/src/features/create/csv.test.ts 와 example/ 의 파일에서 왔다.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { CsvError, decodeUtf8, parseCsv, readCsvFile, splitRecords } from '../src/lib/csv.js';

const EXAMPLE = new URL('../../example/', import.meta.url);
const bytes = (path) => readFileSync(new URL(path, EXAMPLE));
// 브라우저에서 파일을 올릴 때와 같이 바이트에서 시작한다 (인코딩 검사를 거친다)
const upload = (path) => readCsvFile(Object.assign(new Blob([bytes(path)]), { name: path.split('/').pop() }));

describe('splitRecords', () => {
  it('쉼표, LF, CRLF, CR 로 나누고 따옴표 안의 쉼표와 줄바꿈은 글자로 둔다', () => {
    const { records, quoteProblems } = splitRecords('a,b\r\n1,"x,y"\r"p\nq",2\n');
    assert.deepEqual(records, [
      ['a', 'b'],
      ['1', 'x,y'],
      ['p\nq', '2'],
    ]);
    assert.equal(quoteProblems, 0);
  });

  it('겹따옴표("")는 따옴표 하나이고, 마지막 줄에 줄바꿈이 없어도 된다', () => {
    const { records } = splitRecords('a\n"say ""hi"""');
    assert.deepEqual(records, [['a'], ['say "hi"']]);
  });

  it('쉼표로 끝난 레코드는 빈 셀이 하나 더 있다', () => {
    assert.deepEqual(splitRecords('a,b,\n1,2,').records, [
      ['a', 'b', ''],
      ['1', '2', ''],
    ]);
  });

  it('닫히지 않은 따옴표와 닫는 따옴표 뒤의 글자는 quoting problem 으로 센다', () => {
    assert.equal(splitRecords('a\n"open').quoteProblems, 1);
    const tail = splitRecords('a,b\n"x"y,2\n');
    assert.equal(tail.quoteProblems, 1);
    assert.deepEqual(tail.records[1], ['xy', '2']);
  });
});

describe('parseCsv', () => {
  it('keeps every cell as a string', () => {
    const csv = parseCsv('idx,flag,ratio\n1,true,0.50\n02,false,1e3\n', 'a.csv');
    assert.deepEqual(csv.columns, ['idx', 'flag', 'ratio']);
    assert.deepEqual(csv.rows, [
      { idx: '1', flag: 'true', ratio: '0.50' },
      { idx: '02', flag: 'false', ratio: '1e3' },
    ]);
    assert.equal(csv.fileName, 'a.csv');
    assert.equal(csv.hadBom, false);
    assert.deepEqual(csv.warnings, []);
  });

  it('strips a UTF-8 BOM from the first header name', () => {
    const csv = parseCsv('﻿idx,query\n1,hello\n', 'bom.csv');
    assert.deepEqual(csv.columns, ['idx', 'query']);
    assert.deepEqual(csv.rows[0], { idx: '1', query: 'hello' });
    assert.equal(csv.hadBom, true);
  });

  it('reads quoted cells with commas, quotes and line breaks (Python list strings)', () => {
    const cell = `['a "quoted" fact', 'second, with comma',\n 'third']`;
    const csv = parseCsv(`idx,atomic_facts\n1,"${cell.replace(/"/g, '""')}"\n`, 'q.csv');
    assert.equal(csv.rows.length, 1);
    assert.equal(csv.rows[0].atomic_facts, cell);
  });

  it('reads CRLF line endings', () => {
    const csv = parseCsv('a,b\r\n1,2\r\n3,4\r\n', 'crlf.csv');
    assert.deepEqual(csv.rows, [
      { a: '1', b: '2' },
      { a: '3', b: '4' },
    ]);
  });

  it('skips blank lines, including lines of only commas or spaces', () => {
    const csv = parseCsv('a,b\n1,2\n\n , \n3,4\n\n', 'blank.csv');
    assert.deepEqual(csv.rows, [
      { a: '1', b: '2' },
      { a: '3', b: '4' },
    ]);
    assert.deepEqual(csv.warnings, []);
  });

  it('handles a cell larger than 100 KB', () => {
    const big = 'x'.repeat(150 * 1024);
    const csv = parseCsv(`id,passage\n1,"${big}"\n`, 'big.csv');
    assert.equal(csv.rows[0].passage.length, big.length);
  });

  it('pads short rows, drops extra cells and reports the rows (1-based)', () => {
    const csv = parseCsv('a,b,c\n1,2,3\n4,5\n6,7,8,9\n', 'ragged.csv');
    assert.deepEqual(csv.rows, [
      { a: '1', b: '2', c: '3' },
      { a: '4', b: '5', c: '' },
      { a: '6', b: '7', c: '8' },
    ]);
    assert.equal(csv.warnings.length, 1);
    assert.ok(csv.warnings[0].includes('Row(s) 2, 3'));
    assert.ok(csv.warnings[0].includes('do not have 3 cells like the header'));
  });

  it('drops columns with an empty header name', () => {
    const csv = parseCsv('a,b,\n1,2,\n', 'trailing.csv');
    assert.deepEqual(csv.columns, ['a', 'b']);
    assert.deepEqual(csv.rows, [{ a: '1', b: '2' }]);
    assert.ok(csv.warnings.join(' ').includes('empty header name'));
  });

  it('reports renamed duplicate headers', () => {
    const csv = parseCsv('a,a\n1,2\n', 'dup.csv');
    assert.equal(csv.columns.length, 2);
    assert.equal(new Set(csv.columns).size, 2);
    assert.deepEqual(csv.rows, [{ a: '1', a_1: '2' }]);
    assert.ok(csv.warnings.join(' ').includes('Duplicate header'));
    assert.ok(csv.warnings.join(' ').includes('a → a_1'));
  });

  it('reports quoting problems', () => {
    const csv = parseCsv('a,b\n"x"y,2\n', 'quotes.csv');
    assert.ok(csv.warnings.some((w) => w.includes('1 quoting problem(s)')));
  });

  it('rejects a file without rows or without a header', () => {
    assert.throws(() => parseCsv('a,b\n', 'empty.csv'), CsvError);
    assert.throws(() => parseCsv('a,b\n', 'empty.csv'), /has a header row but no data rows/);
    assert.throws(() => parseCsv('', 'nothing.csv'), CsvError);
    assert.throws(() => parseCsv('', 'nothing.csv'), /has no header row/);
  });

  it('reads the bundled sample CSV: 10 rows, 5 columns, no empty cells', () => {
    const csv = parseCsv(bytes('1-task-data/data.csv').toString('utf8'), 'data.csv');
    assert.deepEqual(csv.columns, ['item_id', 'passage', 'sentence_1', 'sentence_2', 'attention_sentence']);
    assert.equal(csv.rows.length, 10);
    assert.deepEqual(csv.warnings, []);
    assert.ok(csv.rows.every((row) => csv.columns.every((c) => row[c].trim() !== '')));
  });
});

describe('decodeUtf8', () => {
  it('keeps the BOM so that parseCsv can report it', () => {
    const encoded = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('a,b\n가,나\n')]);
    const csv = parseCsv(decodeUtf8(encoded.buffer), 'ko.csv');
    assert.equal(csv.hadBom, true);
    assert.deepEqual(csv.rows, [{ a: '가', b: '나' }]);
  });

  it('rejects bytes that are not UTF-8 (e.g. CP949 from Excel) with the message from the docs', () => {
    const cp949 = new Uint8Array([0x61, 0x2c, 0x62, 0x0a, 0xb0, 0xa1, 0x2c, 0xb3, 0xaa, 0x0a]); // "a,b\n가,나\n"
    assert.throws(() => decodeUtf8(cp949.buffer), CsvError);
    assert.throws(() => decodeUtf8(cp949.buffer), /^CsvError: The file is not valid UTF-8\. Save it again as "CSV UTF-8" and upload it again\.$/);
  });
});

describe('readCsvFile with the example files (scenario 3)', () => {
  it('excel-utf8-bom.csv: BOM 을 떼고 정상 처리한다 (CRLF)', async () => {
    assert.deepEqual([...bytes('3-data-checks/excel-utf8-bom.csv').subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    const csv = await upload('3-data-checks/excel-utf8-bom.csv');
    assert.equal(csv.hadBom, true);
    assert.equal(csv.columns[0], 'item_id');
    assert.equal(csv.rows.length, 10);
    assert.deepEqual(csv.warnings, []);
  });

  it('excel-cp949.csv: UTF-8 이 아니라서 거절한다', async () => {
    await assert.rejects(upload('3-data-checks/excel-cp949.csv'), CsvError);
    await assert.rejects(upload('3-data-checks/excel-cp949.csv'), /not valid UTF-8/);
  });

  it('empty-cells.csv 와 large-rows.csv 는 경고 없이 읽힌다', async () => {
    const empty = await upload('3-data-checks/empty-cells.csv');
    assert.equal(empty.rows.length, 6);
    assert.deepEqual(empty.warnings, []);
    const large = await upload('3-data-checks/large-rows.csv');
    assert.equal(large.rows.length, 3);
    assert.deepEqual(large.warnings, []);
  });
});

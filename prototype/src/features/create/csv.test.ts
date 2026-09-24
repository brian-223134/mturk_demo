import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CsvError, decodeUtf8, parseCsv } from './csv';

describe('parseCsv', () => {
  it('keeps every cell as a string', () => {
    const csv = parseCsv('idx,flag,ratio\n1,true,0.50\n02,false,1e3\n', 'a.csv');
    expect(csv.columns).toEqual(['idx', 'flag', 'ratio']);
    expect(csv.rows).toEqual([
      { idx: '1', flag: 'true', ratio: '0.50' },
      { idx: '02', flag: 'false', ratio: '1e3' },
    ]);
    expect(csv.fileName).toBe('a.csv');
    expect(csv.hadBom).toBe(false);
    expect(csv.warnings).toEqual([]);
  });

  it('strips a UTF-8 BOM from the first header name', () => {
    const csv = parseCsv('﻿idx,query\n1,hello\n', 'bom.csv');
    expect(csv.columns).toEqual(['idx', 'query']);
    expect(csv.rows[0]).toEqual({ idx: '1', query: 'hello' });
    expect(csv.hadBom).toBe(true);
  });

  it('reads quoted cells with commas, quotes and line breaks (Python list strings)', () => {
    const cell = `['a "quoted" fact', 'second, with comma',\n 'third']`;
    const csv = parseCsv(`idx,atomic_facts\n1,"${cell.replace(/"/g, '""')}"\n`, 'q.csv');
    expect(csv.rows).toHaveLength(1);
    expect(csv.rows[0]!.atomic_facts).toBe(cell);
  });

  it('skips blank lines, including lines of only commas or spaces', () => {
    const csv = parseCsv('a,b\n1,2\n\n , \n3,4\n\n', 'blank.csv');
    expect(csv.rows).toEqual([
      { a: '1', b: '2' },
      { a: '3', b: '4' },
    ]);
  });

  it('handles a cell larger than 100 KB', () => {
    const big = 'x'.repeat(150 * 1024);
    const csv = parseCsv(`id,passage\n1,"${big}"\n`, 'big.csv');
    expect(csv.rows[0]!.passage).toHaveLength(big.length);
  });

  it('pads short rows, drops extra cells and reports the rows (1-based)', () => {
    const csv = parseCsv('a,b,c\n1,2,3\n4,5\n6,7,8,9\n', 'ragged.csv');
    expect(csv.rows).toEqual([
      { a: '1', b: '2', c: '3' },
      { a: '4', b: '5', c: '' },
      { a: '6', b: '7', c: '8' },
    ]);
    expect(csv.warnings).toHaveLength(1);
    expect(csv.warnings[0]).toContain('Row(s) 2, 3');
  });

  it('drops columns with an empty header name', () => {
    const csv = parseCsv('a,b,\n1,2,\n', 'trailing.csv');
    expect(csv.columns).toEqual(['a', 'b']);
    expect(csv.rows).toEqual([{ a: '1', b: '2' }]);
    expect(csv.warnings.join(' ')).toContain('empty header name');
  });

  it('reports renamed duplicate headers', () => {
    const csv = parseCsv('a,a\n1,2\n', 'dup.csv');
    expect(csv.columns).toHaveLength(2);
    expect(new Set(csv.columns).size).toBe(2);
    expect(csv.warnings.join(' ')).toContain('Duplicate header');
  });

  it('rejects a file without rows or without a header', () => {
    expect(() => parseCsv('a,b\n', 'empty.csv')).toThrow(CsvError);
    expect(() => parseCsv('', 'nothing.csv')).toThrow(CsvError);
  });

  it('reads the bundled sample CSV: 10 rows, 5 columns, no empty cells', () => {
    const text = readFileSync(new URL('../../../../example/1-task-data/data.csv', import.meta.url), 'utf8');
    const csv = parseCsv(text, 'data.csv');
    expect(csv.columns).toEqual(['item_id', 'passage', 'sentence_1', 'sentence_2', 'attention_sentence']);
    expect(csv.rows).toHaveLength(10);
    expect(csv.warnings).toEqual([]);
    expect(csv.rows.every((row) => csv.columns.every((c) => row[c]!.trim() !== ''))).toBe(true);
  });
});

describe('decodeUtf8', () => {
  it('keeps the BOM so that parseCsv can report it', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('a,b\n가,나\n')]);
    const csv = parseCsv(decodeUtf8(bytes.buffer), 'ko.csv');
    expect(csv.hadBom).toBe(true);
    expect(csv.rows).toEqual([{ a: '가', b: '나' }]);
  });

  it('rejects bytes that are not UTF-8 (e.g. CP949 from Excel)', () => {
    const cp949 = new Uint8Array([0x61, 0x2c, 0x62, 0x0a, 0xb0, 0xa1, 0x2c, 0xb3, 0xaa, 0x0a]); // "a,b\n가,나\n"
    expect(() => decodeUtf8(cp949.buffer)).toThrow(CsvError);
  });
});

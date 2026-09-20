// example/ 폴더의 파일이 README의 "업로드 시나리오"에 적힌 대로 동작하는지 확인한다.
// 화면의 Data 단계와 같은 함수(readCsvFile, checkData)를 쓰므로, 예시 파일이나 검사 규칙이 바뀌면 여기서 드러난다.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkData } from '../../domain/dataCheck';
import { extractPlaceholders } from '../../domain/template';
import { CsvError, readCsvFile } from './csv';

const root = process.cwd();
const bytes = (path: string) => readFileSync(resolve(root, 'example', path));
const text = (path: string) => readFileSync(resolve(root, path), 'utf-8');
// 브라우저에서 파일을 올릴 때와 같이 바이트에서 시작한다 (인코딩 검사를 거친다)
const upload = (path: string) => readCsvFile(Object.assign(new Blob([bytes(path)]), { name: path.split('/').pop() }));

const taskDataTemplate = extractPlaceholders(text('example/1-task-data/template.html'));
const placeholderTemplate = extractPlaceholders(text('example/2-placeholder/template.html'));

describe('시나리오 1: TASK_DATA 방식', () => {
  it('템플릿에는 ${...}가 없고, CSV는 10행 5컬럼이다', async () => {
    expect(taskDataTemplate).toEqual([]);
    const csv = await upload('1-task-data/data.csv');
    expect(csv).toMatchObject({ hadBom: false, columns: ['item_id', 'passage', 'sentence_1', 'sentence_2', 'attention_sentence'] });
    const check = checkData(taskDataTemplate, csv.columns, csv.rows);
    expect(check).toMatchObject({ rowCount: 10, columnCount: 5, missingColumns: [], rowsWithEmptyCells: [], rowsOverQuestionLimit: 0 });
    expect(check.unusedColumns).toHaveLength(5); // 전부 window.TASK_DATA로 쓸 수 있는 컬럼이다
  });
});

describe('시나리오 2: ${컬럼명} 방식', () => {
  it('템플릿의 placeholder는 5개다', () => {
    expect(placeholderTemplate).toEqual(['item_id', 'passage', 'sentence_1', 'attention_sentence', 'sentence_2']);
  });

  it('data.csv는 5/5가 맞고, 안 쓰는 컬럼 note를 안내한다', async () => {
    const csv = await upload('2-placeholder/data.csv');
    const check = checkData(placeholderTemplate, csv.columns, csv.rows);
    expect(check).toMatchObject({ rowCount: 8, columnCount: 6, missingColumns: [], unusedColumns: ['note'] });
    expect(check.matchedPlaceholders).toHaveLength(5);
  });

  it('data-missing-column.csv는 sentence_2가 없어 막힌다', async () => {
    const csv = await upload('2-placeholder/data-missing-column.csv');
    const check = checkData(placeholderTemplate, csv.columns, csv.rows);
    expect(check.missingColumns).toEqual(['sentence_2']);
    expect(check.matchedPlaceholders).toHaveLength(4);
  });
});

describe('시나리오 3: Data 단계의 검사', () => {
  it('empty-cells.csv: 3행과 5행에 빈 셀이 있다', async () => {
    const csv = await upload('3-data-checks/empty-cells.csv');
    expect(checkData(taskDataTemplate, csv.columns, csv.rows).rowsWithEmptyCells).toEqual([2, 4]); // 0부터 센다
  });

  it('excel-utf8-bom.csv: BOM을 떼고 정상 처리한다', async () => {
    expect([...bytes('3-data-checks/excel-utf8-bom.csv').subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const csv = await upload('3-data-checks/excel-utf8-bom.csv');
    expect(csv.hadBom).toBe(true);
    expect(csv.columns[0]).toBe('item_id'); // BOM이 컬럼 이름에 남지 않는다
    expect(csv.rows).toHaveLength(10);
  });

  it('excel-cp949.csv: UTF-8이 아니라서 거절한다', async () => {
    await expect(upload('3-data-checks/excel-cp949.csv')).rejects.toBeInstanceOf(CsvError);
    await expect(upload('3-data-checks/excel-cp949.csv')).rejects.toThrow(/not valid UTF-8/);
  });

  it('large-rows.csv: 한 행이 64KB를 넘는다', async () => {
    const csv = await upload('3-data-checks/large-rows.csv');
    const check = checkData(taskDataTemplate, csv.columns, csv.rows);
    expect(check.rowsOverQuestionLimit).toBe(1);
    expect(check.rowSizeMaxBytes).toBeGreaterThan(64 * 1024);
  });
});

describe('시나리오 4: 콘솔에 저장돼 있는 기존 템플릿', () => {
  it.each([
    ['chunk-fact-relevance.html', '4-saved-templates/chunk-fact-relevance-input.csv', 10],
    ['query-fact-coverage.html', '4-saved-templates/query-fact-coverage-input.csv', 8],
  ])('%s + %s: 12/12가 맞고 *_reasoning 4개는 안 쓰는 컬럼이다', async (template, file, rows) => {
    const placeholders = extractPlaceholders(text(`data/templates/${template}`));
    const csv = await upload(file);
    const check = checkData(placeholders, csv.columns, csv.rows);
    expect(check).toMatchObject({ rowCount: rows, columnCount: 16, missingColumns: [], rowsOverQuestionLimit: 0 });
    expect(check.matchedPlaceholders).toHaveLength(12);
    expect(check.unusedColumns.every((c) => c.endsWith('_reasoning'))).toBe(true);
    expect(check.unusedColumns).toHaveLength(4);
  });

  it('이 템플릿에 시나리오 1의 CSV를 올리면 12개가 전부 없다고 나온다', async () => {
    const placeholders = extractPlaceholders(text('data/templates/chunk-fact-relevance.html'));
    const csv = await upload('1-task-data/data.csv');
    expect(checkData(placeholders, csv.columns, csv.rows).missingColumns).toHaveLength(12);
  });
});

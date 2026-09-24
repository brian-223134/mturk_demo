// lib/data-check.js: checkData 와 Data 단계의 검사 줄. example/ 의 파일이 README 의 "업로드 시나리오"에 적힌 대로 동작하는지 확인한다
// (prototype/src/features/create/examples.test.ts 를 옮겼다). 화면의 Data 단계와 같은 함수(readCsvFile, checkData, checkLines)를 쓰므로,
// 예시 파일이나 검사 규칙이 바뀌면 여기서 드러난다.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { readCsvFile } from '../src/lib/csv.js';
import { QUESTION_SIZE_LIMIT_BYTES, checkData, checkLines, describeCsv, formatBytes, listSome, median, rowSizeBytes } from '../src/lib/data-check.js';
import { extractPlaceholders } from '../src/lib/template.js';

const ROOT = new URL('../../', import.meta.url); // 저장소 루트 (example/ 와 data/ 가 있는 곳)
const bytes = (path) => readFileSync(new URL(`example/${path}`, ROOT));
const text = (path) => readFileSync(new URL(path, ROOT), 'utf8');
const upload = (path) => readCsvFile(Object.assign(new Blob([bytes(path)]), { name: path.split('/').pop() }));

const taskDataTemplate = extractPlaceholders(text('example/1-task-data/template.html'));
const placeholderTemplate = extractPlaceholders(text('example/2-placeholder/template.html'));
const byKey = (lines) => Object.fromEntries(lines.map((line) => [line.key, line]));

describe('helpers', () => {
  it('median, rowSizeBytes(UTF-8 바이트), formatBytes, listSome', () => {
    assert.equal(median([]), null);
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([1, 2, 3, 4]), 2.5);
    assert.equal(rowSizeBytes({ a: 'ab', b: '가' }), 2 + 3);
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(70.2 * 1024), '70.2 KB');
    assert.equal(listSome(['a', 'b']), 'a, b');
    assert.equal(listSome('abcdefghij'.split('')), 'a, b, c, d, e, f, g, h, … (+2 more)');
    assert.equal(QUESTION_SIZE_LIMIT_BYTES, 65536);
  });
});

describe('시나리오 1: TASK_DATA 방식', () => {
  it('템플릿에는 ${...} 가 없고, CSV 는 10행 5컬럼이다', async () => {
    assert.deepEqual(taskDataTemplate, []);
    const csv = await upload('1-task-data/data.csv');
    assert.equal(csv.hadBom, false);
    assert.deepEqual(csv.columns, ['item_id', 'passage', 'sentence_1', 'sentence_2', 'attention_sentence']);
    const check = checkData(taskDataTemplate, csv.columns, csv.rows);
    assert.equal(check.rowCount, 10);
    assert.equal(check.columnCount, 5);
    assert.deepEqual(check.missingColumns, []);
    assert.deepEqual(check.rowsWithEmptyCells, []);
    assert.equal(check.rowsOverQuestionLimit, 0);
    assert.equal(check.unusedColumns.length, 5); // 전부 window.TASK_DATA 로 쓸 수 있는 컬럼이다
    assert.equal(describeCsv(check, csv.hadBom), '10 rows, 5 columns, UTF-8');

    const lines = byKey(checkLines(check, taskDataTemplate));
    assert.equal(lines['task-data'].level, 'ok');
    assert.equal(lines['task-data'].text, 'This template has no ${...} placeholders. It reads the row from window.TASK_DATA, so there is nothing to match.');
    assert.equal(lines.unused.level, 'info');
    assert.equal(
      lines.unused.text,
      '5 column(s) are available to the template through window.TASK_DATA: item_id, passage, sentence_1, sentence_2, attention_sentence. Not a problem.',
    );
    assert.equal(lines.size.level, 'info');
    assert.ok(lines.size.text.startsWith('Row input size: median '));
    assert.equal(lines.missing, undefined);
    assert.equal(lines.empty, undefined);
  });
});

describe('시나리오 2: ${컬럼명} 방식', () => {
  it('템플릿의 placeholder 는 5개다', () => {
    assert.deepEqual(placeholderTemplate, ['item_id', 'passage', 'sentence_1', 'attention_sentence', 'sentence_2']);
  });

  it('data.csv 는 5/5 가 맞고, 안 쓰는 컬럼 note 를 WARN 으로 안내한다', async () => {
    const csv = await upload('2-placeholder/data.csv');
    const check = checkData(placeholderTemplate, csv.columns, csv.rows);
    assert.equal(check.rowCount, 8);
    assert.equal(check.columnCount, 6);
    assert.deepEqual(check.missingColumns, []);
    assert.deepEqual(check.unusedColumns, ['note']);
    assert.equal(check.matchedPlaceholders.length, 5);
    assert.equal(describeCsv(check, csv.hadBom), '8 rows, 6 columns, UTF-8');

    const lines = byKey(checkLines(check, placeholderTemplate));
    assert.equal(lines.matched.level, 'ok');
    assert.equal(lines.matched.text, '5/5 matched with a CSV column:');
    assert.deepEqual(lines.matched.names, placeholderTemplate);
    assert.equal(lines.unused.level, 'warn');
    assert.equal(lines.unused.text, '1 column(s) not used by the template: note. They are still stored with each HIT.');
  });

  it('data-missing-column.csv 는 sentence_2 가 없어 ERROR 로 막힌다', async () => {
    const csv = await upload('2-placeholder/data-missing-column.csv');
    const check = checkData(placeholderTemplate, csv.columns, csv.rows);
    assert.deepEqual(check.missingColumns, ['sentence_2']);
    assert.equal(check.matchedPlaceholders.length, 4);

    const lines = checkLines(check, placeholderTemplate);
    assert.equal(lines[0].level, 'error');
    assert.equal(lines[0].text, '1 placeholder(s) have no matching CSV column:');
    assert.deepEqual(lines[0].names, ['sentence_2']);
    assert.ok(lines[0].note.startsWith('An unsubstituted ${x} stays in the page'));
    // 일부만 맞은 줄은 OK 가 아니라 INFO 다
    assert.equal(byKey(lines).matched.level, 'info');
    assert.equal(byKey(lines).matched.text, '4/5 matched with a CSV column:');
  });
});

describe('시나리오 3: Data 단계의 검사', () => {
  it('empty-cells.csv: 3행과 5행에 빈 셀이 있다', async () => {
    const csv = await upload('3-data-checks/empty-cells.csv');
    const check = checkData(taskDataTemplate, csv.columns, csv.rows);
    assert.deepEqual(check.rowsWithEmptyCells, [2, 4]); // 0부터 센다
    const line = byKey(checkLines(check, taskDataTemplate)).empty;
    assert.equal(line.level, 'warn');
    assert.equal(line.text, '2 row(s) have empty cells: row 3, 5.');
  });

  it('excel-utf8-bom.csv: BOM 을 떼고 정상 처리하고 "UTF-8 (BOM removed)" 로 알린다', async () => {
    const csv = await upload('3-data-checks/excel-utf8-bom.csv');
    const check = checkData(taskDataTemplate, csv.columns, csv.rows);
    assert.equal(describeCsv(check, csv.hadBom), '10 rows, 5 columns, UTF-8 (BOM removed)');
    assert.deepEqual(check.missingColumns, []);
  });

  it('large-rows.csv: 한 행이 64KB 를 넘어 WARN max 70.2 KB 다', async () => {
    const csv = await upload('3-data-checks/large-rows.csv');
    const check = checkData(taskDataTemplate, csv.columns, csv.rows);
    assert.equal(check.rowsOverQuestionLimit, 1);
    assert.ok(check.rowSizeMaxBytes > 64 * 1024);
    const line = byKey(checkLines(check, taskDataTemplate)).size;
    assert.equal(line.level, 'warn');
    assert.ok(line.text.includes('max 70.2 KB.'), line.text);
    assert.ok(line.text.includes("1 row(s) exceed MTurk's 64 KB Question limit, so the MTurk integration will have to publish this batch as an ExternalQuestion. The mock environment is not affected."));
  });
});

describe('시나리오 4: 콘솔에 저장돼 있는 기존 템플릿', () => {
  for (const [template, file, rows, sizes] of [
    ['chunk-fact-relevance.html', '4-saved-templates/chunk-fact-relevance-input.csv', 10, 'median 18.7 KB, max 38.0 KB'],
    ['query-fact-coverage.html', '4-saved-templates/query-fact-coverage-input.csv', 8, 'median 6.3 KB, max 8.1 KB'],
  ]) {
    it(`${template} + ${file}: 12/12 가 맞고 *_reasoning 4개는 안 쓰는 컬럼이다`, async () => {
      const placeholders = extractPlaceholders(text(`data/templates/${template}`));
      const csv = await upload(file);
      const check = checkData(placeholders, csv.columns, csv.rows);
      assert.equal(check.rowCount, rows);
      assert.equal(check.columnCount, 16);
      assert.deepEqual(check.missingColumns, []);
      assert.equal(check.rowsOverQuestionLimit, 0);
      assert.equal(check.matchedPlaceholders.length, 12);
      assert.ok(check.unusedColumns.every((c) => c.endsWith('_reasoning')));
      assert.equal(check.unusedColumns.length, 4);

      const lines = byKey(checkLines(check, placeholders));
      assert.equal(lines.matched.level, 'ok');
      assert.equal(lines.matched.text, '12/12 matched with a CSV column:');
      assert.equal(lines.unused.level, 'warn');
      assert.ok(lines.unused.text.startsWith('4 column(s) not used by the template: '));
      assert.equal(lines.size.text, `Row input size: ${sizes}.`);
    });
  }

  it('이 템플릿에 시나리오 1의 CSV 를 올리면 12개가 전부 없다고 나온다', async () => {
    const placeholders = extractPlaceholders(text('data/templates/chunk-fact-relevance.html'));
    const csv = await upload('1-task-data/data.csv');
    const check = checkData(placeholders, csv.columns, csv.rows);
    assert.equal(check.missingColumns.length, 12);
    const lines = checkLines(check, placeholders);
    assert.equal(lines[0].level, 'error');
    assert.equal(lines[0].text, '12 placeholder(s) have no matching CSV column:');
    assert.equal(byKey(lines).matched, undefined); // 맞은 것이 하나도 없으면 matched 줄이 없다
  });
});

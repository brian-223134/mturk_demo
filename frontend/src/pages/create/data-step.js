// Create (2) Data: CSV 업로드와 placeholder 검증. 파일은 서버로 보내지 않고 브라우저에서 읽는다 (lib/csv.js).
// 검사 줄의 문구는 lib/data-check.js 의 checkLines 가 만든다 (README 의 시나리오 표가 인용하는 문구).

import { tag } from '../../components/badges.js';
import { el } from '../../components/dom.js';
import { muted, notice } from '../../components/notice.js';
import { table } from '../../components/table.js';
import { decodeUtf8, parseCsv, readCsvFile } from '../../lib/csv.js';
import { checkLines, describeCsv } from '../../lib/data-check.js';
import { failureNotice, fetchExample, placeholderTags, stepFooter } from './common.js';

export const SAMPLE_CSV_PATH = '1-task-data/data.csv';
const PREVIEW_ROWS = 5;
// 셀 하나가 100KB 를 넘기도 한다. 표와 tooltip 에는 잘라서 넣는다.
const CELL_CHARS = 80;
const TOOLTIP_CHARS = 1000;

const LEVELS = {
  ok: ['green', 'OK'],
  error: ['red', 'ERROR'],
  warn: ['gold', 'WARN'],
  info: ['blue', 'INFO'],
};

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function previewCell(text) {
  if (text === '') return el('span', { className: 'muted' }, '(empty)');
  if (text.length <= CELL_CHARS) return text;
  const tip = text.length > TOOLTIP_CHARS ? `${text.slice(0, TOOLTIP_CHARS)}… (${text.length.toLocaleString('en-US')} characters in total)` : text;
  return el('span', { title: tip, className: 'cell-truncated' }, truncate(text, CELL_CHARS));
}

function checkLine(line) {
  const [color, label] = LEVELS[line.level];
  return el(
    'div',
    { className: `check-line check-${line.level}`, dataset: { level: line.level, key: line.key } },
    tag(label, color, { className: 'check-tag' }),
    el(
      'div',
      { className: 'check-body' },
      el('div', { className: 'check-text' }, line.text, line.names ? [' ', placeholderTags(line.names, { color: line.level === 'error' ? 'error' : undefined })] : null),
      line.note ? el('div', { className: 'muted small check-note' }, line.note) : null,
    ),
  );
}

export function renderDataStep(ctx) {
  const { draft, template, check } = ctx;
  const { data } = draft;
  const errorSlot = el('div', { id: 'data-error' });
  let reading = false;

  const accept = (next) => ctx.update({ data: next, previewRow: 0 });
  const fail = (what, error) => errorSlot.replaceChildren(failureNotice(`Could not read ${what}`, error));

  async function readFile(file) {
    if (reading) return;
    reading = true;
    errorSlot.replaceChildren();
    try {
      accept(await readCsvFile(file));
    } catch (error) {
      if (!ctx.signal.aborted) fail(file.name, error);
    } finally {
      reading = false;
    }
  }

  const sampleButton = el('button', { type: 'button', className: 'btn btn-small', id: 'load-sample-csv' }, 'Load sample CSV');
  sampleButton.addEventListener('click', async () => {
    sampleButton.disabled = true;
    errorSlot.replaceChildren();
    try {
      // example/ 폴더의 파일을 그대로 쓴다. 사람이 직접 올려 보는 파일과 버튼이 채우는 내용이 같다.
      const bytes = await fetchExample(SAMPLE_CSV_PATH, 'bytes');
      if (ctx.signal.aborted) return;
      accept(parseCsv(decodeUtf8(bytes), 'data.csv'));
    } catch (error) {
      if (ctx.signal.aborted) return;
      sampleButton.disabled = false;
      fail('the sample CSV', error);
    }
  });

  // 끌어다 놓기 영역. 안의 file input 을 눌러도 되고, 파일을 떨어뜨려도 된다.
  const fileInput = el('input', { type: 'file', id: 'csv-file', accept: '.csv,text/csv', className: 'dropzone-input' });
  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    if (file) void readFile(file);
    fileInput.value = '';
  });
  const dropzone = el(
    'label',
    { className: `dropzone${data ? ' dropzone-compact' : ''}`, id: 'csv-dropzone', for: 'csv-file' },
    fileInput,
    data
      ? el('span', { className: 'dropzone-text' }, `Drop another CSV here, or click to replace ${data.fileName}`)
      : [
          el('span', { className: 'dropzone-text' }, 'Drop a CSV file here, or click to choose one'),
          el('span', { className: 'muted small' }, 'One row becomes one HIT. The header row names the columns. UTF-8; large cells are fine.'),
        ],
  );
  for (const type of ['dragenter', 'dragover']) {
    dropzone.addEventListener(type, (event) => {
      event.preventDefault();
      dropzone.classList.add('dragging');
    });
  }
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragging'));
  dropzone.addEventListener('drop', (event) => {
    event.preventDefault();
    dropzone.classList.remove('dragging');
    const file = event.dataTransfer?.files?.[0];
    if (file) void readFile(file);
  });

  const parts = [];
  if (data && check) {
    parts.push(
      el(
        'div',
        { className: 'data-summary', id: 'data-summary' },
        el('strong', { id: 'data-file-name' }, data.fileName),
        el('span', { id: 'data-shape' }, describeCsv(check, data.hadBom)),
        el('button', { type: 'button', className: 'btn btn-small', id: 'csv-remove', onClick: () => ctx.update({ data: null, previewRow: 0 }) }, 'Remove'),
      ),
    );
    if (data.warnings.length > 0) {
      parts.push(notice('warning', 'The file was read with warnings', null, el('ul', { className: 'warning-list', id: 'csv-warnings' }, data.warnings.map((w) => el('li', {}, w)))));
    }
    parts.push(
      el('h4', { className: 'section-title' }, 'Placeholder check'),
      muted(`Template: ${template.name}`),
      el('div', { className: 'check-list', id: 'check-list' }, checkLines(check, template.placeholders).map(checkLine)),
      el('h4', { className: 'section-title' }, `Preview (first ${Math.min(PREVIEW_ROWS, data.rows.length)} rows)`),
      el(
        'div',
        { className: 'table-scroll' },
        table({
          columns: [
            { title: '#', width: 56, align: 'right', render: (r) => r.index + 1 },
            ...data.columns.map((name) => ({ title: name, className: 'cell-data', render: (r) => previewCell(r.row[name] ?? '') })),
          ],
          rows: data.rows.slice(0, PREVIEW_ROWS).map((row, index) => ({ index, row })),
          rowKey: (r) => r.index,
          className: 'data-preview',
        }),
      ),
    );
    parts[parts.length - 1].id = 'data-preview';
  }

  const blocked = !data || !check || check.missingColumns.length > 0;
  const node = el(
    'section',
    { className: 'panel step', id: 'step-data' },
    el('div', { className: 'panel-head' }, el('h3', { className: 'panel-title' }, 'Data'), sampleButton),
    dropzone,
    errorSlot,
    parts,
    stepFooter({
      onBack: () => ctx.goTo(0),
      onNext: () => ctx.goTo(2),
      nextDisabled: blocked,
      hint: !data ? 'Upload a CSV to continue.' : blocked ? 'Fix the missing columns to continue.' : undefined,
    }),
  );
  return { node };
}

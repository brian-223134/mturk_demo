// Publish Batch (1) Upload CSV: CSV 업로드와 placeholder 검증. 파일은 서버로 보내지 않고 브라우저에서 읽는다 (lib/csv.js).
// 검사 줄의 문구는 lib/data-check.js 의 checkLines 가 만든다 (README 의 시나리오 표가 인용하는 문구).
// MTurk 처럼 Project 의 변수를 머리줄로 둔 CSV 양식을 내려받을 수 있고, 시험 삼아 Project 의 표본 행을 HIT 1개로 올릴 수도 있다.

import { tag } from '../../components/badges.js';
import { el } from '../../components/dom.js';
import { muted, notice } from '../../components/notice.js';
import { table } from '../../components/table.js';
import { readCsvFile } from '../../lib/csv.js';
import { checkLines, describeCsv } from '../../lib/data-check.js';
import { navigate } from '../../router.js';
import { downloadCsvTemplate, failureNotice, placeholderTags, stepFooter } from './common.js';

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

  const templateButton = el('button', { type: 'button', className: 'btn btn-small', id: 'download-csv-template', disabled: template.placeholders.length === 0, title: 'A CSV with the columns this project reads and its sample values as the first row' }, 'Download CSV template');
  templateButton.addEventListener('click', () => downloadCsvTemplate(template.name, template.html, template.sampleRow ?? {}));
  const sampleButton = el('button', { type: 'button', className: 'btn btn-small', id: 'use-sample-row', disabled: template.placeholders.length === 0, title: 'Publish one HIT with the sample values of the project, to try the flow' }, 'Use the sample row');
  sampleButton.addEventListener('click', () => {
    const row = Object.fromEntries(template.placeholders.map((name) => [name, template.sampleRow?.[name] ?? '']));
    errorSlot.replaceChildren();
    accept({ fileName: 'sample row', columns: [...template.placeholders], rows: [row], hadBom: false, warnings: [] });
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
      muted(`Project: ${template.name}`),
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
    el('div', { className: 'panel-head' }, el('h3', { className: 'panel-title' }, 'Upload CSV'), el('span', { className: 'panel-actions' }, templateButton, sampleButton)),
    dropzone,
    errorSlot,
    parts,
    stepFooter({
      onBack: () => navigate('/create'),
      backLabel: 'Back to projects',
      onNext: () => ctx.goTo(1),
      nextDisabled: blocked,
      hint: !data ? 'Upload a CSV to continue.' : blocked ? 'Fix the missing columns to continue.' : undefined,
    }),
  );
  return { node };
}

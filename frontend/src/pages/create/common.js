// Create 화면들(Project 목록, New Project, Project 편집기, Publish Batch)이 함께 쓰는 작은 조각: 위쪽 구분 탭, Back / Next 줄,
// `${이름}` 태그, 폼 항목, 구분 버튼, 요약 표, CSV 양식 내려받기, 잔액 갱신.

import { api } from '../../api-client/client.js';
import { tag } from '../../components/badges.js';
import { el } from '../../components/dom.js';
import { downloadFile } from '../../components/download.js';
import { formatDateTime } from '../../components/format.js';
import { notice } from '../../components/notice.js';
import { formatCsv } from '../../lib/csv.js';
import { lintLayout } from '../../lib/layout-lint.js';
import { extractPlaceholders } from '../../lib/template.js';

/** MTurk 의 Create 화면처럼 위쪽에 두 갈래를 둔다. active: 'projects' | 'new' */
export function createSubnav(active) {
  const item = (key, href, label) => el('a', { href, className: `subnav-link${key === active ? ' active' : ''}`, dataset: { subnav: key }, 'aria-current': key === active ? 'page' : null }, label);
  return el('nav', { className: 'subnav', id: 'create-subnav', 'aria-label': 'Create' }, item('projects', '/create', 'New Batch with an Existing Project'), item('new', '/create/new', 'New Project'));
}

const LAYOUT_KINDS = {
  ann: ['blue', 'Elements'],
  crowd: ['gold', 'crowd-html'],
  html: ['default', 'HTML'],
  empty: ['red', 'Empty'],
};

/** layout 이 무엇으로 쓰였는지 작은 태그 (lib/layout-lint.js 의 kind). */
export function layoutKindTag(html) {
  const [color, label] = LAYOUT_KINDS[lintLayout(html).kind];
  return tag(label, color, { className: 'layout-kind', title: label === 'Elements' ? 'Built with <ann-*> elements' : label === 'crowd-html' ? 'Uses crowd-html-elements from assets.crowd.aws' : undefined });
}

/** 파일 이름에 쓸 수 있게 바꾼다. */
export function fileSlug(name) {
  return String(name).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
}

/**
 * MTurk 의 "Download CSV template": layout 이 읽는 컬럼을 머리줄로, 표본 행을 첫 행으로 둔 CSV 를 내려받는다.
 * 그대로 올리면 HIT 1개짜리 batch 가 된다.
 */
export function downloadCsvTemplate(name, html, sampleRow = {}) {
  const columns = extractPlaceholders(html);
  const row = Object.fromEntries(columns.map((column) => [column, sampleRow[column] ?? '']));
  downloadFile({ filename: `${fileSlug(name)}-template.csv`, mimeType: 'text/csv', content: formatCsv(columns, [row]) });
}

/** 모든 단계의 아래쪽 Back / Next 줄. hint 는 Next 가 막혀 있는 이유처럼 버튼 옆에 짧게 알릴 것. */
export function stepFooter({ onBack, onNext, backLabel = 'Back', nextLabel = 'Next', nextDisabled = false, hint, nextId = 'next-btn' }) {
  const next = el('button', { type: 'button', className: 'btn btn-primary', id: nextId, disabled: nextDisabled, onClick: onNext }, nextLabel);
  return el(
    'div',
    { className: 'step-footer' },
    hint ? el('span', { className: 'muted step-hint', id: 'step-hint' }, hint) : null,
    onBack ? el('button', { type: 'button', className: 'btn', id: 'back-btn', onClick: onBack }, backLabel) : null,
    next,
  );
}

/** `${컬럼명}` 목록. placeholder 가 없는 템플릿은 TASK_DATA 방식이다. */
export function placeholderTags(names, { color, empty = 'none (uses window.TASK_DATA)' } = {}) {
  if (names.length === 0) return el('span', { className: 'muted placeholder-empty' }, empty);
  return el(
    'span',
    { className: 'placeholder-list' },
    names.map((name) => el('code', { className: `placeholder${color ? ` placeholder-${color}` : ''}` }, `\${${name}}`)),
  );
}

/** 폼 항목: 라벨, 입력, 안내(hint), 오류 문구 자리(.field-error). setError(text) 로 오류를 보이거나 지운다. */
export function field({ id, label, control, hint, required = false, className = '' }) {
  const error = el('div', { className: 'field-error', dataset: { for: id } });
  const node = el(
    'div',
    { className: `field${className ? ` ${className}` : ''}`, dataset: { field: id } },
    label ? el('label', { for: id }, label, required ? el('span', { className: 'required', 'aria-hidden': 'true' }, ' *') : null) : null,
    control,
    hint ? el('div', { className: 'hint' }, hint) : null,
    error,
  );
  node.setError = (text) => {
    error.textContent = text ?? '';
    node.classList.toggle('has-error', Boolean(text));
  };
  return node;
}

/** 구분 버튼 (antd Segmented). options: [{ value, label }]. */
export function segmented({ id, options, value, onChange }) {
  const node = el('div', { className: 'segmented', id, role: 'tablist' });
  for (const option of options) {
    node.append(
      el(
        'button',
        {
          type: 'button',
          role: 'tab',
          className: `segmented-item${option.value === value ? ' active' : ''}`,
          dataset: { value: option.value },
          'aria-selected': option.value === value ? 'true' : 'false',
          onClick: () => option.value !== value && onChange(option.value),
        },
        option.label,
      ),
    );
  }
  return node;
}

/** 요약 표 (dl.desc). items: [{ label, value, wide }]. value 는 문자열이나 노드. */
export function descList(items, attrs = {}) {
  const dl = el('dl', { ...attrs, className: `desc${attrs.className ? ` ${attrs.className}` : ''}` });
  for (const item of items) {
    dl.append(el('dt', {}, item.label), el('dd', { className: item.wide ? 'wide' : null, dataset: item.key ? { key: item.key } : null }, item.value));
  }
  return dl;
}

export function sectionTitle(text) {
  return el('h4', { className: 'section-title' }, text);
}

export function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

/** 오류를 한 줄 제목 + 내용으로 보이는 안내 상자 (알림 대신). */
export function failureNotice(title, error) {
  return notice('error', title, errorText(error));
}

/** 제목 줄의 잔액을 다시 받는다. 게시 뒤에 잔액이 줄어든 것을 바로 보이려는 것이다 (layout.js 와 같은 표기). */
export async function refreshBalance() {
  const balance = document.getElementById('balance');
  if (!balance) return;
  try {
    const account = await api.getAccount();
    balance.textContent = `Balance $${account.AvailableBalance}`;
  } catch {
    // 제목 줄은 다음 화면에서 다시 그려진다
  }
}

export function formatSaved(iso) {
  return formatDateTime(iso);
}

/** 잠깐 보였다가 사라지는 안내. */
export function flash(slot, node, ms = 4000) {
  slot.replaceChildren(node);
  setTimeout(() => {
    if (node.parentNode === slot) node.remove();
  }, ms);
}

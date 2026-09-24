// Create 마법사의 단계들이 함께 쓰는 작은 조각: Back / Next 줄, `${이름}` 태그, 폼 항목, 구분 버튼, 요약 표, 예시 파일 읽기, 잔액 갱신.

import { api } from '../../api-client/client.js';
import { el } from '../../components/dom.js';
import { formatDateTime } from '../../components/format.js';
import { notice } from '../../components/notice.js';

/** 모든 단계의 아래쪽 Back / Next 줄. hint 는 Next 가 막혀 있는 이유처럼 버튼 옆에 짧게 알릴 것. */
export function stepFooter({ onBack, onNext, nextLabel = 'Next', nextDisabled = false, hint, nextId = 'next-btn' }) {
  const next = el('button', { type: 'button', className: 'btn btn-primary', id: nextId, disabled: nextDisabled, onClick: onNext }, nextLabel);
  return el(
    'div',
    { className: 'step-footer' },
    hint ? el('span', { className: 'muted step-hint', id: 'step-hint' }, hint) : null,
    onBack ? el('button', { type: 'button', className: 'btn', id: 'back-btn', onClick: onBack }, 'Back') : null,
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

/**
 * example/ 의 파일을 읽는다. nginx 가 /usr/share/nginx/example 을 /example/ 로 잇는다 (compose 의 bind mount, Dockerfile 의 COPY).
 * 그 location 은 SPA fallback 이 아니라 404 로 답하므로 상태 코드만 본다.
 */
export async function fetchExample(path, as = 'text') {
  const response = await fetch(`/example/${path}`, { cache: 'no-cache' });
  if (!response.ok) {
    throw new Error(`The sample file /example/${path} is not served by this frontend (HTTP ${response.status}). Mount or copy example/ into the nginx image.`);
  }
  return as === 'bytes' ? response.arrayBuffer() : response.text();
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

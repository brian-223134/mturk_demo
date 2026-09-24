// 도구줄의 입력 요소. 표의 필터와 정렬은 서버(listQuery)에 맡기고, 여기서는 값을 읽어 onChange 로 넘기기만 한다.
//   selectInput, searchInput, numberInput, checkboxInput, checkboxGroup. 모두 { 요소, value } 가 아니라 요소 하나를 돌려준다.

import { el } from './dom.js';

let seq = 0;
const nextId = (prefix) => `${prefix}-${(seq += 1)}`;

/** options: [{ value, label }]. 값은 문자열로 비교한다. */
export function selectInput({ id = nextId('select'), label, value = '', options, onChange, className = '', title }) {
  const select = el(
    'select',
    { id, className: 'input', title, onChange: (event) => onChange?.(event.target.value) },
    options.map((o) => el('option', { value: String(o.value), selected: String(o.value) === String(value ?? '') }, o.label)),
  );
  return field({ id, label, control: select, className });
}

/** 글자 검색. Enter 나 포커스 이탈 때 onSearch(값) 을 부른다. 지우기(×)도 onSearch('') 다. */
export function searchInput({ id = nextId('search'), label, value = '', placeholder = 'Search', onSearch, className = '', width }) {
  let last = value;
  const fire = () => {
    const next = input.value.trim();
    if (next === last) return;
    last = next;
    onSearch?.(next);
  };
  const input = el('input', {
    id,
    type: 'search',
    className: 'input',
    value,
    placeholder,
    style: width ? { width: `${width}px` } : null,
    onKeydown: (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        fire();
      }
    },
    onChange: fire,
    onInput: () => {
      if (input.value === '') fire();
    },
  });
  return field({ id, label, control: input, className });
}

export function numberInput({ id = nextId('number'), label, value, min, max, step = 1, placeholder, suffix, onChange, className = '', width = 120 }) {
  const input = el('input', {
    id,
    type: 'number',
    className: 'input',
    value: value === null || value === undefined ? '' : String(value),
    min: min === undefined ? null : String(min),
    max: max === undefined ? null : String(max),
    step: String(step),
    placeholder,
    style: { width: `${width}px` },
    onChange: () => onChange?.(input.value === '' ? null : Number(input.value)),
  });
  const control = suffix ? el('span', { className: 'input-suffix' }, input, el('span', { className: 'suffix' }, suffix)) : input;
  return field({ id, label, control, className });
}

export function checkboxInput({ id = nextId('check'), label, checked = false, onChange, className = '', disabled = false }) {
  const input = el('input', { id, type: 'checkbox', checked, disabled, onChange: (event) => onChange?.(event.target.checked) });
  return el('label', { className: `checkbox${className ? ` ${className}` : ''}`, for: id }, input, el('span', {}, label));
}

/** 여러 값을 고르는 체크 묶음 (상태 필터). onChange(선택된 값 배열) */
export function checkboxGroup({ label, options, value = [], onChange, className = '' }) {
  const chosen = new Set(value.map(String));
  const boxes = options.map((o) =>
    checkboxInput({
      label: o.label,
      checked: chosen.has(String(o.value)),
      onChange: (checked) => {
        if (checked) chosen.add(String(o.value));
        else chosen.delete(String(o.value));
        onChange?.(options.map((x) => String(x.value)).filter((v) => chosen.has(v)));
      },
    }),
  );
  return el('div', { className: `filter filter-group${className ? ` ${className}` : ''}`, role: 'group', 'aria-label': label }, label ? el('span', { className: 'filter-label' }, label) : null, boxes);
}

function field({ id, label, control, className }) {
  return el('div', { className: `filter${className ? ` ${className}` : ''}` }, label ? el('label', { className: 'filter-label', for: id }, label) : null, control);
}

/** 여러 줄 입력 칸 (모달의 피드백, 메모). */
export function textArea({ id = nextId('text'), value = '', rows = 3, maxLength, placeholder, onInput, autofocus = false }) {
  return el('textarea', { id, className: 'input', rows: String(rows), maxlength: maxLength ? String(maxLength) : null, placeholder, autofocus, onInput: (event) => onInput?.(event.target.value) }, value);
}

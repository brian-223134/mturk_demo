// binding 을 JSON 대신 폼으로 고칠 때 쓰는 계산. 드롭다운의 목록은 데이터 구조에서 만들고, 고치는 함수는 새 binding 을 돌려준다.
// 없는 값은 키를 지워 binding 을 짧게 둔다. 그러면 lib/design-binding.js 가 예시 문항을 쓰고 경고한다.

import { parsePath } from './design-binding.js';

const SAMPLE_ROWS = 5; // 값의 모양을 볼 HIT 수
const MAX_KEYS = 20; // 키가 아주 많은 객체는 목록을 늘리지 않는다
const HIDDEN_LOOKING = /(^|_)(q?id|idx|ids|index|counts?|check|reasoning|reason|label|gold|expected)($|\[|\.)/i; // worker 에게 보이지 않을 값은 목록 뒤로 보낸다

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

function firstValue(reader, column) {
  const rows = Math.min(reader.rowCount, SAMPLE_ROWS);
  for (let rowIndex = 0; rowIndex < rows; rowIndex += 1) {
    const value = reader.cell(rowIndex, column);
    if (value !== '' && value !== null && value !== undefined && !(Array.isArray(value) && value.length === 0)) return value;
  }
  return '';
}

const keysOf = (value) => Object.keys(value).filter((key) => parsePath(`x.${key}`) !== null).slice(0, MAX_KEYS);

/**
 * 드롭다운에 보일 경로들. repeating 은 binding 에 repeat 가 있는지다.
 *   values   칸에 넣을 수 있는 값. worker 에게 보이지 않을 법한 값은 뒤에 둔다
 *   lists    항목별 판정의 항목 목록이 될 수 있는 값
 *   repeats  탭을 나눌 수 있는 목록
 */
export function pathChoices(reader, repeating) {
  const values = [];
  const lists = [];
  const repeats = [];
  for (const column of reader.columns) {
    if (parsePath(column) === null) continue;
    const value = firstValue(reader, column);
    if (Array.isArray(value)) {
      repeats.push(column);
      if (!repeating) {
        values.push(column);
        lists.push(column);
        continue;
      }
      const element = value.find((item) => item !== null && item !== undefined);
      if (isObject(element)) {
        for (const key of keysOf(element)) {
          values.push(`${column}[i].${key}`);
          if (Array.isArray(element[key])) lists.push(`${column}[i].${key}`);
        }
      } else {
        values.push(`${column}[i]`);
        lists.push(Array.isArray(element) ? `${column}[i]` : column); // 글 목록이면 모든 탭에 같은 항목을 보인다
      }
    } else if (isObject(value)) {
      values.push(column);
      for (const key of keysOf(value)) {
        values.push(`${column}.${key}`);
        if (Array.isArray(value[key])) {
          lists.push(`${column}.${key}`);
          repeats.push(`${column}.${key}`);
        }
      }
    } else {
      values.push(column);
    }
  }
  const shownFirst = (path) => (HIDDEN_LOOKING.test(path) ? 1 : 0);
  values.sort((a, b) => shownFirst(a) - shownFirst(b));
  return { values, lists, repeats };
}

/** 경로로 만든 칸 제목. retrieved_chunk[i] → Retrieved chunk */
export function labelFromPath(path) {
  const parsed = parsePath(path);
  const words = (parsed?.column ?? String(path)).replace(/[_-]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** 값이 비면 키를 지운 객체. */
function withValue(object, key, value) {
  const next = { ...object };
  if (value === '' || value === undefined || value === null) delete next[key];
  else next[key] = value;
  return next;
}

/** where 는 데이터 칸 이름이나 context 다. */
export function fieldsIn(binding, where) {
  const spec = where === 'context' ? binding.context : binding.slots?.[where];
  return (Array.isArray(spec) ? spec : spec === undefined || spec === null ? [] : [spec]).map((field) => (isObject(field) ? field : {}));
}

function writeFields(binding, where, fields) {
  const value = fields.length === 0 ? undefined : where === 'context' ? fields : fields.length === 1 ? fields[0] : fields;
  if (where === 'context') return withValue(binding, 'context', value);
  return { ...binding, slots: withValue(binding.slots ?? {}, where, value) };
}

export function updateField(binding, where, index, key, value) {
  return writeFields(binding, where, fieldsIn(binding, where).map((field, at) => (at === index ? withValue(field, key, value) : field)));
}

export function addField(binding, where, values) {
  const fields = fieldsIn(binding, where);
  const used = new Set(fields.map((field) => field.from));
  const from = values.find((path) => !used.has(path)) ?? values[0];
  return writeFields(binding, where, [...fields, { label: labelFromPath(from), from }]);
}

export function removeField(binding, where, index) {
  return writeFields(binding, where, fieldsIn(binding, where).filter((_, at) => at !== index));
}

/** 문항 칸의 값 하나를 고친다. 다 비면 칸을 지워 예시 문항으로 돌아간다. */
export function updateAnswer(binding, slot, key, value) {
  const spec = withValue(binding.slots?.[slot] ?? {}, key, value);
  return { ...binding, slots: withValue(binding.slots ?? {}, slot, Object.keys(spec).length > 0 ? spec : undefined) };
}

export function updateRepeat(binding, over, label) {
  if (!over) return withValue(binding, 'repeat', undefined);
  const next = withValue({ ...binding.repeat, over }, 'label', label);
  return { ...binding, repeat: next };
}

export function updateInstructions(binding, text) {
  return withValue(binding, 'instructions', text);
}

const REFERENCE_FORMS = ['value', 'map', 'selected'];

export function referenceForm(binding) {
  return isObject(binding.reference) ? REFERENCE_FORMS.find((form) => binding.reference[form] !== undefined) ?? '' : '';
}

/** 대조 기준의 형식을 바꾼다. 경로는 이어 가고, 그 형식에 없는 키는 지운다. */
export function setReferenceForm(binding, form, firstPath) {
  if (!form) return withValue(binding, 'reference', undefined);
  const before = isObject(binding.reference) ? binding.reference : {};
  const path = before[referenceForm(binding)] ?? firstPath;
  const reference = { [form]: path };
  if (form !== 'value' && before.key !== undefined) reference.key = before.key;
  if (form === 'selected') for (const key of ['item', 'yes', 'no']) if (before[key] !== undefined) reference[key] = before[key];
  return { ...binding, reference };
}

export function updateReference(binding, key, value) {
  return { ...binding, reference: withValue(isObject(binding.reference) ? binding.reference : {}, key, value) };
}

/** flag 를 비우면 attention 전체가 사라진다. expected 만 비우면 표시만 남고 판정하지 않는다. */
export function updateAttention(binding, key, value) {
  const attention = withValue(isObject(binding.attention) ? binding.attention : {}, key, value);
  return withValue(binding, 'attention', attention.flag === undefined ? undefined : attention);
}

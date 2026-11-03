// binding 을 요청 문장으로 고치는 대화의 기록. 답을 받을 때마다 대화에 한 줄이 쌓이고, binding 이 있는 줄로는 언제든 돌아갈 수 있다.
//   { kind: 'draft', text }                 파일을 올릴 때 코드가 만든 첫 binding
//   { kind: 'edit', text }                  사람이 폼이나 편집기로 고친 binding. 다음 요청을 보내기 전에 남긴다
//   { kind: 'model', text, request, message, changes, problems, meta }  LLM 이 쓰거나 고친 binding
//   { kind: 'reply', request, message, cannot, meta }  binding 이 바뀌지 않은 답. cannot 은 layout, format 또는 null 이다
// binding 의 unused 는 가안을 바꿀 때 값을 보관하는 자리라 LLM 에 보내지 않고, 비교에서도 뺀다.

import { SLOT_LABELS } from './rough-designs.js';

const EARLIER_REQUESTS = 5; // LLM 이 "그것" 같은 말을 알아들을 만큼만 보낸다

/** 키 순서와 상관없는 비교용 글. */
function stableText(value) {
  if (Array.isArray(value)) return `[${value.map(stableText).join(',')}]`;
  if (typeof value === 'object' && value !== null) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableText(value[key])}`).join(',')}}`;
  return JSON.stringify(value ?? null);
}

export function withoutUnused(binding) {
  const { unused, ...rest } = binding;
  return rest;
}

export function sameBinding(a, b) {
  return stableText(withoutUnused(a)) === stableText(withoutUnused(b));
}

const parseText = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const fieldsText = (spec) => (Array.isArray(spec) ? spec : spec ? [spec] : []).map((field) => (field?.label ? `${field.label} (${field?.from})` : String(field?.from))).join(', ');
const optionsText = (options) => (Array.isArray(options) ? options : []).map((option) => (Array.isArray(option) ? option[1] ?? option[0] : option)).join(', ');
const plainText = (value) => (value === undefined || value === null ? '' : typeof value === 'string' ? value : stableText(value));
const repeatText = (repeat) => (repeat ? `${repeat.over}${repeat.label ? ` (${repeat.label})` : ''}` : '');
const cellText = (cell) => (Array.isArray(cell) ? cell : [cell]).map((slot) => SLOT_LABELS[slot] ?? String(slot)).join(' + ');
// 한 줄의 칸은 |, 줄 사이는 / 로 나눈다. 없으면 가안의 배치다
const layoutText = (layout) => (Array.isArray(layout?.rows) ? layout.rows.map((row) => `${(Array.isArray(row?.slots) ? row.slots : []).map(cellText).join(' | ')}${row?.columns ? ` (${row.columns})` : ''}`).join(' / ') : '');
const referenceText = (reference) => (reference ? [reference.value ?? reference.map ?? reference.selected, reference.key, reference.item, reference.yes, reference.no].filter((part) => part !== undefined).join(', ') : '');

const ANSWER_PARTS = [
  ['header', 'question', plainText],
  ['options', 'options', optionsText],
  ['items', 'items', plainText],
  ['placeholder', 'hint', plainText],
  ['name', 'answer name', plainText],
];

/**
 * 무엇이 바뀌었는지 사람이 읽을 목록 [{ what, before, after, alert }]. 없던 값과 없어진 값의 글은 '' 이다.
 * alert 는 사람이 부탁하지 않았다면 되돌려야 할 변화다: 대조 기준이나 attention 이 사라졌거나 문항 칸이 비었을 때.
 */
export function describeChanges(before, after) {
  const changes = [];
  const push = (what, from, to, alert = false) => {
    if (from !== to) changes.push({ what, before: from, after: to, alert });
  };
  push('Instructions', plainText(before.instructions), plainText(after.instructions));
  push('Layout', layoutText(before.layout), layoutText(after.layout));
  push('Tabs', repeatText(before.repeat), repeatText(after.repeat));
  const slotNames = [...new Set([...Object.keys(before.slots ?? {}), ...Object.keys(after.slots ?? {})])];
  for (const slot of slotNames) {
    const label = SLOT_LABELS[slot] ?? slot;
    const from = before.slots?.[slot];
    const to = after.slots?.[slot];
    if (slot.startsWith('data')) {
      push(label, fieldsText(from), fieldsText(to));
    } else if (from && !to) {
      push(label, plainText(from.header) || 'set', '', true);
    } else {
      for (const [key, part, read] of ANSWER_PARTS) push(`${label}: ${part}`, read(from?.[key]), read(to?.[key]));
    }
  }
  push('Fields above the slots', fieldsText(before.context), fieldsText(after.context));
  const reference = [referenceText(before.reference), referenceText(after.reference)];
  push('Reference labels', reference[0], reference[1], reference[0] !== '' && reference[1] === '');
  const flag = [plainText(before.attention?.flag), plainText(after.attention?.flag)];
  push('Attention items', flag[0], flag[1], flag[0] !== '' && flag[1] === '');
  const expected = [plainText(before.attention?.expected), plainText(after.attention?.expected)];
  push('Attention answer', expected[0], expected[1], expected[0] !== '' && expected[1] === '');
  return changes;
}

/**
 * LLM 의 답을 대화 기록에 더한 새 목록을 돌려준다. 답 직전의 binding 이 기록에 없으면 함께 남겨 돌아갈 수 있게 한다.
 * before 는 묻기 직전의 binding, authored 는 사람이나 LLM 이 쓴 것인지(아니면 코드의 첫 binding)다.
 */
export function addAnswer(versions, { before, authored, result, request, meta }) {
  const next = [...versions];
  if (!result.binding || sameBinding(before, result.binding)) {
    next.push({ kind: 'reply', request, message: result.message ?? null, cannot: result.cannot ?? null, meta });
    return next;
  }
  const known = next.some((version) => version.text !== undefined && sameBinding(parseText(version.text) ?? {}, before));
  if (!known) next.push({ kind: authored ? 'edit' : 'draft', text: JSON.stringify(before, null, 2) });
  next.push({ kind: 'model', text: JSON.stringify(result.binding, null, 2), request, message: result.message ?? null, changes: describeChanges(before, result.binding), problems: result.errors ?? [], meta });
  return next;
}

/** 이 줄의 binding 이 지금 binding 과 같은지. 같으면 화면에서 Restore 대신 현재 표시를 낸다. */
export function isCurrentVersion(version, binding) {
  if (version.text === undefined || !binding) return false;
  const parsed = parseText(version.text);
  return parsed !== null && sameBinding(parsed, binding);
}

/** LLM 에 함께 보낼 앞선 요청들. 오래된 것부터. */
export function earlierRequests(versions) {
  return versions.flatMap((version) => (version.request ? [version.request] : [])).slice(-EARLIER_REQUESTS);
}

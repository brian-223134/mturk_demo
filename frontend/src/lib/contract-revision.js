// 자유 계약을 요청 문장으로 고치는 대화의 기록 (binding 의 lib/binding-revision.js 와 같은 모양).
//   { kind: 'edit', text }                                          사람이 폼이나 JSON 으로 고친 계약. 다음 요청 전에 남긴다
//   { kind: 'model', text, request, message, changes, problems, meta }  LLM 이 쓰거나 고친 계약
//   { kind: 'reply', request, message, cannot, meta }               계약이 바뀌지 않은 답
// 비교는 키 순서와 상관없이 한다. 문항은 name, 값은 id 로 짝을 짓는다.

import { earlierRequests } from './binding-revision.js';

export { earlierRequests };

function stableText(value) {
  if (Array.isArray(value)) return `[${value.map(stableText).join(',')}]`;
  if (typeof value === 'object' && value !== null) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableText(value[key])}`).join(',')}}`;
  return JSON.stringify(value ?? null);
}

export function sameContract(a, b) {
  return stableText(a ?? null) === stableText(b ?? null);
}

const parseText = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const list = (value) => (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]);
const optionsText = (options) => list(options).map((option) => (Array.isArray(option) ? option[1] ?? option[0] : option)).join(', ');
const itemsText = (items) => (Array.isArray(items) ? items.map((item) => (typeof item === 'object' && item !== null ? item.text : item)).join(', ') : items ?? '');
const fieldText = (field) => (field ? `${field.label ?? field.id} (${field.from}${field.kind && field.kind !== 'text' ? `, ${field.kind}` : ''})` : '');
const scaleText = (q) => (q?.type === 'likert' ? `${q.min ?? 1} to ${q.max ?? 5}` : '');
const referenceText = (ref) => (ref ? [ref.value ?? ref.map ?? ref.selected, ref.key, ref.item, ref.yes, ref.no].filter((part) => part !== undefined).join(', ') : '');
const attentionText = (attention) => (attention ? `${attention.flag} → ${attention.question} = ${attention.expected ?? '?'}` : '');

/**
 * 무엇이 바뀌었는지 사람이 읽을 목록 [{ what, before, after, alert }]. 없던 값과 없어진 값의 글은 '' 이다.
 * alert 는 부탁하지 않았다면 되돌려야 할 변화다: 문항이 없어졌거나 이름이 바뀌어 답이 이어지지 않거나, 대조 기준·attention 이 사라졌을 때.
 */
export function describeContractChanges(before = {}, after = {}) {
  const changes = [];
  const push = (what, from, to, alert = false) => {
    if (from !== to) changes.push({ what, before: from, after: to, alert });
  };
  push('Instructions', before?.instructions ?? '', after?.instructions ?? '');
  push('Items', before?.repeat ? `${before.repeat.over} (${before.repeat.label ?? 'Item'})` : '', after?.repeat ? `${after.repeat.over} (${after.repeat.label ?? 'Item'})` : '');

  const fieldsBefore = new Map(list(before?.fields).map((field) => [field.id, field]));
  const fieldsAfter = new Map(list(after?.fields).map((field) => [field.id, field]));
  for (const id of new Set([...fieldsBefore.keys(), ...fieldsAfter.keys()])) push(`Value ${fieldsAfter.get(id)?.label ?? fieldsBefore.get(id)?.label ?? id}`, fieldText(fieldsBefore.get(id)), fieldText(fieldsAfter.get(id)));

  const questionsBefore = new Map(list(before?.questions).map((q) => [q.name, q]));
  const questionsAfter = new Map(list(after?.questions).map((q) => [q.name, q]));
  for (const name of new Set([...questionsBefore.keys(), ...questionsAfter.keys()])) {
    const from = questionsBefore.get(name);
    const to = questionsAfter.get(name);
    if (from && !to) {
      push(`Question ${name}`, from.header ?? name, '', true);
      continue;
    }
    if (!from) {
      push(`Question ${name}`, '', `${to.header} (${to.type})`);
      continue;
    }
    push(`Question ${name}: header`, from.header ?? '', to.header ?? '');
    push(`Question ${name}: kind`, from.type ?? '', to.type ?? '');
    push(`Question ${name}: options`, optionsText(from.options), optionsText(to.options));
    push(`Question ${name}: items`, itemsText(from.items), itemsText(to.items));
    push(`Question ${name}: scale`, scaleText(from), scaleText(to));
  }

  const refsBefore = new Map(list(before?.reference).map((ref) => [ref.question, ref]));
  const refsAfter = new Map(list(after?.reference).map((ref) => [ref.question, ref]));
  for (const name of new Set([...refsBefore.keys(), ...refsAfter.keys()])) {
    const from = referenceText(refsBefore.get(name));
    const to = referenceText(refsAfter.get(name));
    push(`Answer key for ${name}`, from, to, from !== '' && to === '');
  }
  const attention = [attentionText(before?.attention), attentionText(after?.attention)];
  push('Attention checks', attention[0], attention[1], attention[0] !== '' && attention[1] === '');
  return changes;
}

/** LLM 의 답을 대화 기록에 더한 새 목록. 답 직전의 계약이 기록에 없으면 함께 남겨 돌아갈 수 있게 한다. */
export function addContractAnswer(versions, { before, result, request, meta }) {
  const next = [...versions];
  if (!result.contract || sameContract(before, result.contract)) {
    next.push({ kind: 'reply', request, message: result.message ?? null, cannot: result.cannot ?? null, meta });
    return next;
  }
  if (before) {
    const known = next.some((version) => version.text !== undefined && sameContract(parseText(version.text), before));
    if (!known) next.push({ kind: 'edit', text: JSON.stringify(before, null, 2) });
  }
  next.push({ kind: 'model', text: JSON.stringify(result.contract, null, 2), request, message: result.message ?? null, changes: before ? describeContractChanges(before, result.contract) : [], problems: result.errors ?? [], meta });
  return next;
}

/** 이 줄의 계약이 지금 계약과 같은지. */
export function isCurrentContract(version, contract) {
  if (version.text === undefined || !contract) return false;
  const parsed = parseText(version.text);
  return parsed !== null && sameContract(parsed, contract);
}

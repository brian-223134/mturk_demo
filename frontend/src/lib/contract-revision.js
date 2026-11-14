// 자유 계약을 요청 문장으로 고치는 대화의 기록 (binding 의 lib/binding-revision.js 와 같은 모양).
//   { kind: 'edit', text, page? }                                          사람이 폼이나 JSON 으로 고친 계약. 다음 요청 전에 남긴다
//   { kind: 'model', text, request, message, changes, problems, meta, page? }  LLM 이 쓰거나 고친 계약
//   { kind: 'reply', request, message, cannot, meta }                      계약이 바뀌지 않은 답
// Draft with AI 는 과제와 페이지를 한 대화에서 고친다. page 는 그 계약으로 다시 쓴 페이지 { html, message, checks, remaining, error }
// 이며(없으면 기본 페이지), Restore 는 계약과 페이지를 함께 되돌린다.
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
const unitText = (unit) => {
  if (!unit || typeof unit !== 'object') return '';
  const how = [unit.group_by ? `grouped by ${unit.group_by}` : null, unit.split ? `${unit.split.from} split into ${unit.split.by}s` : null].filter(Boolean);
  return `${unit.level ?? '?'}${how.length > 0 ? ` (${how.join(', ')})` : ''}`;
};

/**
 * 무엇이 바뀌었는지 사람이 읽을 목록 [{ what, before, after, alert }]. 없던 값과 없어진 값의 글은 '' 이다.
 * alert 는 부탁하지 않았다면 되돌려야 할 변화다: 문항이 없어졌거나 이름이 바뀌어 답이 이어지지 않거나, 대조 기준·attention 이 사라졌을 때.
 */
export function describeContractChanges(before = {}, after = {}) {
  const changes = [];
  const push = (what, from, to, alert = false) => {
    if (from !== to) changes.push({ what, before: from, after: to, alert });
  };
  push('Unit', unitText(before?.unit), unitText(after?.unit));
  push('Instructions', before?.instructions ?? '', after?.instructions ?? '');
  const repeatText = (repeat) => (repeat ? `${repeat.over} (${repeat.label ?? 'Item'}${repeat.per_hit ? `, ${repeat.per_hit} per HIT` : ''})` : '');
  push('Items', repeatText(before?.repeat), repeatText(after?.repeat));

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

  // 페이지 바람: 문장 단위로 더하고 뺀다
  const wishesBefore = list(before?.layout).map(String);
  const wishesAfter = list(after?.layout).map(String);
  for (const wish of wishesBefore) if (!wishesAfter.includes(wish)) push('Page', wish, '');
  for (const wish of wishesAfter) if (!wishesBefore.includes(wish)) push('Page', '', wish);
  return changes;
}

/**
 * LLM 의 답을 대화 기록에 더한 새 목록. 답 직전의 계약이 기록에 없으면 함께 남겨 돌아갈 수 있게 한다.
 * beforePage 는 답 직전의 페이지다 (Draft with AI). 새 답의 페이지는 그린 뒤 setVersionPage 로 붙인다.
 */
export function addContractAnswer(versions, { before, beforePage, result, request, meta }) {
  const next = [...versions];
  if (!result.contract || sameContract(before, result.contract)) {
    next.push({ kind: 'reply', request, message: result.message ?? null, cannot: result.cannot ?? null, meta });
    return next;
  }
  if (before) {
    const known = next.some((version) => version.text !== undefined && sameContract(parseText(version.text), before));
    if (!known) next.push({ kind: 'edit', text: JSON.stringify(before, null, 2), ...(beforePage !== undefined ? { page: beforePage } : {}) });
  }
  next.push({ kind: 'model', text: JSON.stringify(result.contract, null, 2), request, message: result.message ?? null, changes: before ? describeContractChanges(before, result.contract) : [], problems: result.errors ?? [], meta });
  return next;
}

/** 마지막 줄에 페이지 결과를 붙인 새 목록 (계약을 쓴 뒤 페이지를 다시 쓰고 판정하는 데 시간이 걸린다). */
export function setVersionPage(versions, page) {
  if (versions.length === 0) return versions;
  const last = versions[versions.length - 1];
  return [...versions.slice(0, -1), { ...last, page }];
}

/** 이 줄로 돌아갈 때의 페이지. 페이지 기록이 없는 줄(예전 기록)은 null(기본 페이지)이다. */
export function versionPage(version) {
  return version?.page ?? null;
}

/** 이 줄의 계약이 지금 계약과 같은지. */
export function isCurrentContract(version, contract) {
  if (version.text === undefined || !contract) return false;
  const parsed = parseText(version.text);
  return parsed !== null && sameContract(parsed, contract);
}

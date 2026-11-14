// 자유 계약을 JSON 대신 폼으로 고칠 때 쓰는 계산. 고치는 함수는 모두 새 계약을 돌려준다 (lib/binding-form.js 와 같은 방식).
// 드롭다운의 경로 목록은 binding 폼의 pathChoices 를 그대로 쓴다. 대조 기준은 폼에서 value 형식(문항마다 경로 하나)만 고치고,
// map·selected 형식은 그대로 두며 JSON 으로 고치게 안내한다.

import { labelFromPath } from './binding-form.js';
import { parsePath } from './design-binding.js';

export { pathChoices } from './binding-form.js';

export const QUESTION_KINDS = [
  ['choice', 'Pick one'],
  ['likert', 'Score'],
  ['checklist', 'Check all that apply'],
  ['item-choice', 'One answer per item'],
  ['text', 'Written answer'],
];

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const list = (value) => (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]);

function withValue(object, key, value) {
  const next = { ...object };
  if (value === '' || value === undefined || value === null) delete next[key];
  else next[key] = value;
  return next;
}

const slug = (text) => String(text).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'value';

function uniqueName(base, used) {
  const start = /^[a-z_]/.test(base) ? base : `q_${base}`;
  if (!used.has(start)) return start;
  for (let n = 2; ; n += 1) if (!used.has(`${start}_${n}`)) return `${start}_${n}`;
}

export function updateInstructions(contract, text) {
  return withValue(contract, 'instructions', text);
}

/** 항목 목록을 바꾼다. 비우면 repeat 이 없어진다 ([i] 경로는 검사가 알린다). */
export function updateRepeat(contract, over, label) {
  if (!over) return withValue(contract, 'repeat', undefined);
  return { ...contract, repeat: withValue({ ...(isObject(contract.repeat) ? contract.repeat : {}), over }, 'label', label) };
}

/** 한 HIT 에 넣을 단위 수 (repeat.per_hit). 비우거나 1 보다 작으면 자르지 않는다. */
export function updatePerHit(contract, value) {
  if (!isObject(contract.repeat)) return contract;
  const number = Number.parseInt(value, 10);
  return { ...contract, repeat: withValue(contract.repeat, 'per_hit', Number.isInteger(number) && number > 0 ? number : undefined) };
}

/** 페이지 바람(layout): 한 줄에 하나. 빈 줄은 버린다. */
export function updateLayout(contract, text) {
  return { ...contract, layout: String(text ?? '').split('\n').map((line) => line.trim()).filter((line) => line !== '') };
}

// ---- 값 ----

export function updateValue(contract, index, key, value) {
  return { ...contract, fields: list(contract.fields).map((field, at) => (at === index ? withValue(field, key, value) : field)) };
}

export function addValue(contract, choices) {
  const fields = list(contract.fields);
  const used = new Set(fields.map((field) => field.from));
  const from = choices.find((path) => !used.has(path)) ?? choices[0] ?? '';
  const id = uniqueName(slug(parsePath(from)?.column ?? 'value'), new Set(fields.map((field) => field.id)));
  return { ...contract, fields: [...fields, { id, label: labelFromPath(from), from }] };
}

export function removeValue(contract, index) {
  return { ...contract, fields: list(contract.fields).filter((_, at) => at !== index) };
}

// ---- 문항 ----

const defaultsFor = (type, lists) => {
  if (type === 'choice') return { options: [['yes', 'Yes'], ['no', 'No']] };
  if (type === 'item-choice') return { options: [['yes', 'Yes'], ['no', 'No']], items: lists[0] ?? ['First item', 'Second item'] };
  if (type === 'checklist') return { items: ['First item', 'Second item'] };
  if (type === 'likert') return { min: 1, max: 5 };
  return {};
};

const TYPE_KEYS = { choice: ['options', 'layout'], 'item-choice': ['options', 'items'], checklist: ['items', 'checked', 'unchecked'], likert: ['min', 'max', 'min_label', 'max_label'], text: ['placeholder'] };

export function updateQuestion(contract, index, key, value) {
  return { ...contract, questions: list(contract.questions).map((question, at) => (at === index ? withValue(question, key, value) : question)) };
}

/** 문항의 종류를 바꾼다. 새 종류에 없는 키는 지우고, 필요한 키는 기본값으로 채운다. */
export function setQuestionType(contract, index, type, lists = []) {
  return {
    ...contract,
    questions: list(contract.questions).map((question, at) => {
      if (at !== index) return question;
      const kept = Object.fromEntries(Object.entries(question).filter(([key]) => ['name', 'header', 'required', 'per_item'].includes(key) || (TYPE_KEYS[type] ?? []).includes(key)));
      return { ...defaultsFor(type, lists), ...kept, type };
    }),
  };
}

export function addQuestion(contract, type = 'choice', lists = []) {
  const questions = list(contract.questions);
  const name = uniqueName(`question_${questions.length + 1}`, new Set(questions.map((q) => q.name)));
  return { ...contract, questions: [...questions, { name, type, header: 'New question', ...defaultsFor(type, lists) }] };
}

/** 문항을 지운다. 그 문항을 가리키던 대조 기준과 attention 도 함께 지운다. */
export function removeQuestion(contract, index) {
  const removed = list(contract.questions)[index]?.name;
  let next = { ...contract, questions: list(contract.questions).filter((_, at) => at !== index) };
  const references = list(contract.reference).filter((ref) => ref.question !== removed);
  next = withValue(next, 'reference', references.length > 0 ? references : undefined);
  if (contract.attention?.question === removed) next = withValue(next, 'attention', undefined);
  return next;
}

const optionPairs = (options) => list(options).map((option) => (Array.isArray(option) ? [String(option[0]), String(option[1] ?? option[0])] : [String(option), String(option)]));

/** 선택지 하나의 값(part 0)이나 글(part 1)을 고친다. */
export function updateOption(contract, index, optionIndex, part, value) {
  const question = list(contract.questions)[index];
  const options = optionPairs(question?.options).map((pair, at) => (at === optionIndex ? pair.map((text, p) => (p === part ? value : text)) : pair));
  return updateQuestion(contract, index, 'options', options);
}

export function addOption(contract, index) {
  const options = optionPairs(list(contract.questions)[index]?.options);
  return updateQuestion(contract, index, 'options', [...options, [`option_${options.length + 1}`, `Option ${options.length + 1}`]]);
}

export function removeOption(contract, index, optionIndex) {
  return updateQuestion(contract, index, 'options', optionPairs(list(contract.questions)[index]?.options).filter((_, at) => at !== optionIndex));
}

/** 항목: 경로(데이터의 목록)이거나, 쉼표로 나눈 글(정해진 항목). */
export function setItems(contract, index, value, fromData) {
  if (fromData) return updateQuestion(contract, index, 'items', value);
  return updateQuestion(contract, index, 'items', String(value).split(',').map((item) => item.trim()).filter(Boolean));
}

// ---- 대조 기준과 attention ----

/** 문항의 대조 기준과 그 형식('' | value | map | selected). */
export function referenceOf(contract, name) {
  const ref = list(contract.reference).find((entry) => entry.question === name) ?? null;
  return { ref, form: ref ? ['value', 'map', 'selected'].find((form) => ref[form] !== undefined) ?? '' : '' };
}

/** value 형식의 대조 기준 경로를 정한다. 비우면 그 문항의 대조 기준을 지운다. */
export function setReferenceValue(contract, name, path) {
  const others = list(contract.reference).filter((entry) => entry.question !== name);
  const references = path ? [...others, { question: name, value: path }] : others;
  return withValue(contract, 'reference', references.length > 0 ? references : undefined);
}

/** flag 를 비우면 attention 전체가 사라진다. */
export function updateAttention(contract, key, value) {
  const attention = withValue(isObject(contract.attention) ? contract.attention : {}, key, value);
  return withValue(contract, 'attention', attention.flag === undefined ? undefined : attention);
}

/** 대조 기준·attention 기대 답이 될 수 있는 값 (task-contract 의 검사와 같은 규칙). */
export function answerValues(question) {
  if (!question) return [];
  if (question.type === 'likert') return Array.from({ length: Math.max(0, (question.max ?? 5) - (question.min ?? 1) + 1) }, (_, i) => String((question.min ?? 1) + i));
  if (question.type === 'checklist') return [String(question.checked ?? 'yes'), String(question.unchecked ?? 'no')];
  return optionPairs(question.options).map(([value]) => value);
}

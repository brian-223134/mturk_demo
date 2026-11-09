// 자유 계약(task contract): 가안(rough design) 없이 Requester 의 prompt 로 정하는 HIT 의 내용.
// 보여 줄 값(fields)과 문항(questions)을 몇 개든, ann 요소의 모든 문항 종류(choice, likert, checklist, item-choice, text)로 적고,
// 문항마다 대조 기준(reference)과 attention 을 단다. 배치는 계약에 없다.
// 코드가 계약으로 기본 템플릿(정답지)과 게시용 행을 만들고, 배치와 표현은 Agent 가 HTML 로 쓴다(html-harness.js 가 정답지와 대조).
//
//   checkContract(contract, reader)                → { errors, warnings, tabs }
//   buildContractTemplate(contract, tabs)          → 기본 템플릿 HTML
//   contractRow(contract, tabs, reader, rowIndex)  → 게시용 행 (값 컬럼 + 쓰지 않은 원래 컬럼 + slot_reference, slot_attention)
//   harnessContract(contract, reader)              → html-harness 가 쓰는 계약 { html, data, tabs, shown, hidden, roles, questions, answerColumns }
//   requestContract({ send, check, request })      → Agent 에게 계약을 묻고 검사해 최대 3번 다시 묻는다
//
// 컬럼 이름: 값은 f_<id>(항목마다면 f_<id>_<탭>), 항목 목록은 q_<문항>_items(_<탭>). 답 이름은 <문항>(_<탭>), 항목별 문항은 그 뒤에 _<항목>.

import { ANSWER_NAME, NOT_ENGLISH, URL_LIKE, displayText, escapeHtml, itemsCell, parsePath, resolvePath } from './design-binding.js';
import { placeholderRoles } from './html-harness.js';
import { ELEMENTS_SCRIPT, lintLayout } from './layout-lint.js';
import { extractPlaceholders } from './template.js';

export const QUESTION_TYPES = ['choice', 'likert', 'checklist', 'item-choice', 'text'];
export const FIELD_KINDS = ['text', 'image', 'video'];
const JUDGED_TYPES = ['choice', 'likert', 'checklist', 'item-choice'];
const REFERENCE_COLUMN = 'slot_reference';
const ATTENTION_COLUMN = 'slot_attention';
const CHECK_ROWS = 20;
// 정답처럼 보이는 컬럼 이름. 대조 기준으로 밝히지 않고 화면에 쓰면 오류다 (Requester 가 정답 컬럼을 말하지 않은 경우를 막는다)
// attention 표시도 worker 에게 보이면 어느 항목이 attention 인지 드러나므로 같이 막는다
const ANSWER_LIKE = /(^|_)(gold|labels?|answers?|expected|truth|correct|check|attention)$/i;

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const asItems = (value) => (Array.isArray(value) ? value : value === null || value === undefined || value === '' ? [] : [value]);
const usesItem = (parsed) => parsed.steps.some((step) => step.index === 'i');
const attr = (text) => escapeHtml(String(text ?? '')).replace(/"/g, '&quot;');
const fillKey = (template, tabIndex, itemNumber) => String(template).replace(/\{i\}/g, String(tabIndex ?? 0)).replace(/\{n\}/g, String(itemNumber));

const fieldsOf = (contract) => (Array.isArray(contract?.fields) ? contract.fields.filter(isObject) : []);
const questionsOf = (contract) => (Array.isArray(contract?.questions) ? contract.questions.filter(isObject) : []);
const referencesOf = (contract) => (contract?.reference === undefined ? [] : asItems(contract.reference).filter(isObject));

/** 값 하나가 탭마다 다른지: 경로에 [i] 가 있으면 항목마다다. */
const fieldPerItem = (field) => {
  const parsed = parsePath(field.from);
  return Boolean(parsed && usesItem(parsed));
};
/** 문항이 탭마다 따로인지: repeat 이 있으면 기본으로 그렇고, per_item: false 면 HIT 에 한 번이다. */
const questionPerItem = (contract, question) => Boolean(contract.repeat) && question.per_item !== false;

const fieldColumn = (field, tab) => `f_${field.id}${tab === null ? '' : `_${tab + 1}`}`;
const itemsColumn = (question, tab) => `q_${question.name}_items${tab === null ? '' : `_${tab + 1}`}`;
const answerBase = (question, tab) => `${question.name}${tab === null ? '' : `_${tab + 1}`}`;

function optionPairs(options) {
  return asItems(options).map((option) => (Array.isArray(option) ? [String(option[0]), String(option[1] ?? option[0])] : [String(option), String(option)]));
}

/** 대조 기준과 attention 기대 답이 될 수 있는 값. */
function allowedValues(question) {
  if (question.type === 'likert') {
    const min = question.min ?? 1;
    const max = question.max ?? 5;
    return Array.from({ length: Math.max(0, max - min + 1) }, (_, index) => String(min + index));
  }
  if (question.type === 'checklist') return [String(question.checked ?? 'yes'), String(question.unchecked ?? 'no')];
  return optionPairs(question.options).map(([value]) => value);
}

function tabIndexes(perItem, tabs) {
  return perItem && tabs > 0 ? Array.from({ length: tabs }, (_, index) => index) : [null];
}

function readPath(path, reader, rowIndex, tab) {
  const parsed = parsePath(path);
  return resolvePath(parsed, reader.cell(rowIndex, parsed.column), tab ?? 0);
}

function itemsFor(question, reader, rowIndex, tab) {
  if (Array.isArray(question.items)) return question.items;
  return asItems(readPath(question.items, reader, rowIndex, tab));
}

/** 문항 하나의 답 이름들. 항목별 문항(checklist, item-choice)은 항목마다 하나다. */
function answerNames(question, tab, items) {
  const base = answerBase(question, tab);
  if (question.type === 'item-choice') return items.map((_, index) => `${base}_${index + 1}`);
  if (question.type === 'checklist') return items.map((item, index) => `${base}_${isObject(item) && item.key !== undefined ? item.key : index + 1}`);
  return [base];
}

/** 대조 기준·attention 의 원래 컬럼. 화면에 쓰면 안 된다. */
function answerSources(contract) {
  const paths = [...referencesOf(contract).map((ref) => ref.value ?? ref.map ?? ref.selected), contract?.attention?.flag];
  return [...new Set(paths.map((path) => parsePath(path)?.column).filter(Boolean))];
}

/** 이 HIT 에서 attention 표시가 있는 탭 번호(0부터, repeat 이 없으면 [null]). */
function attentionTabs(contract, tabs, reader, rowIndex) {
  const flag = contract.attention?.flag;
  if (flag === undefined || !parsePath(flag)) return [];
  const isSet = (value) => value === true || value === 1 || value === '1';
  const perItem = usesItem(parsePath(flag));
  return tabIndexes(perItem && Boolean(contract.repeat), tabs).filter((tab) => isSet(readPath(flag, reader, rowIndex, tab)));
}

/** HIT 하나의 대조 기준 { 답 이름: 라벨 } 과 대조할 수 있었던 답의 수. attention 탭은 뺀다. */
export function referenceValues(contract, tabs, reader, rowIndex) {
  const out = { values: {}, answerCount: 0 };
  const flagged = new Set(attentionTabs(contract, tabs, reader, rowIndex).map((tab) => tab ?? 'all'));
  for (const ref of referencesOf(contract)) {
    const question = questionsOf(contract).find((q) => q.name === ref.question);
    const form = ['value', 'map', 'selected'].find((name) => ref[name] !== undefined);
    if (!question || !form || !parsePath(ref[form])) continue;
    const perItem = questionPerItem(contract, question);
    for (const tab of tabIndexes(perItem, tabs)) {
      if (flagged.has('all') || flagged.has(tab)) continue;
      const root = readPath(ref[form], reader, rowIndex, tab);
      const items = ['checklist', 'item-choice'].includes(question.type) ? itemsFor(question, reader, rowIndex, tab) : [null];
      answerNames(question, tab, items).forEach((name, index) => {
        out.answerCount += 1;
        let label;
        if (form === 'value') label = items[0] === null ? root : asItems(root)[index];
        else if (form === 'map') label = isObject(root) ? root[fillKey(ref.key, tab, index + 1)] : undefined;
        else {
          const selected = isObject(root) ? asItems(root[fillKey(ref.key, tab, index + 1)]) : [];
          label = selected.map(String).includes(fillKey(ref.item, tab, index + 1)) ? ref.yes : ref.no;
        }
        if (['string', 'number', 'boolean'].includes(typeof label)) out.values[name] = String(label);
      });
    }
  }
  return out;
}

/** HIT 하나의 attention 기대 답 { 답 이름: 기대 값 }. */
export function attentionValues(contract, tabs, reader, rowIndex) {
  const out = {};
  const { attention } = contract;
  const question = questionsOf(contract).find((q) => q.name === attention?.question);
  if (!question || attention.expected === undefined) return out;
  for (const flagged of attentionTabs(contract, tabs, reader, rowIndex)) {
    const perItem = questionPerItem(contract, question);
    for (const tab of perItem ? (flagged === null ? tabIndexes(true, tabs) : [flagged]) : [null]) {
      const items = ['checklist', 'item-choice'].includes(question.type) ? itemsFor(question, reader, rowIndex, tab) : [null];
      for (const name of answerNames(question, tab, items)) out[name] = String(attention.expected);
    }
  }
  return out;
}

/** 계약 검사. 오류 문구는 그대로 Agent 에게 다시 보낸다 (영어). */
export function checkContract(contract, reader) {
  const errors = [];
  const warnings = [];
  if (!isObject(contract)) return { errors: ['The contract must be a JSON object.'], warnings, tabs: 0 };
  const columns = new Set(reader.columns);
  const rows = Math.min(reader.rowCount, CHECK_ROWS);

  const checkPath = (where, path, { item = true } = {}) => {
    const parsed = parsePath(path);
    if (!parsed) errors.push(`${where}: ${JSON.stringify(path)} is not a path. Write a column name, optionally followed by [i], [0] or .key.`);
    else if (!columns.has(parsed.column)) errors.push(`${where}: the data has no column "${parsed.column}".`);
    else if (usesItem(parsed) && !contract.repeat) errors.push(`${where}: [i] needs "repeat".`);
    else if (usesItem(parsed) && !item) errors.push(`${where}: [i] is only for values and questions shown once per item.`);
    else return parsed;
    return null;
  };

  // repeat: 한 HIT 의 항목 목록. 탭 수는 가장 긴 목록이다
  let tabs = 0;
  if (contract.repeat !== undefined) {
    const parsed = isObject(contract.repeat) ? checkPath('repeat.over', contract.repeat.over, { item: false }) : null;
    if (!isObject(contract.repeat)) errors.push('"repeat" must be an object like {"over": "<list column>", "label": "Item"}.');
    if (parsed) {
      const counts = Array.from({ length: reader.rowCount }, (_, rowIndex) => resolvePath(parsed, reader.cell(rowIndex, parsed.column), 0)).map((value) => (Array.isArray(value) ? value.length : -1));
      const bad = counts.flatMap((count, rowIndex) => (count < 0 ? [rowIndex + 1] : []));
      if (bad.length > 0) errors.push(`repeat.over: "${contract.repeat.over}" is not a list in ${bad.length} HIT(s), starting with HIT ${bad[0]}.`);
      else {
        tabs = Math.max(0, ...counts);
        if (tabs === 0) errors.push(`repeat.over: "${contract.repeat.over}" is empty in every HIT.`);
        else if (Math.min(...counts) !== tabs) warnings.push(`HITs have different numbers of items (${Math.min(...counts)} to ${tabs}). Shorter HITs show empty items.`);
      }
    }
  }

  if (typeof contract.instructions !== 'string' || contract.instructions.trim() === '') errors.push('"instructions" must be one or two sentences for workers.');

  // fields: 보여 줄 값
  const fields = fieldsOf(contract);
  if (fields.length === 0) errors.push('"fields" must list at least one value to show.');
  const ids = new Set();
  fields.forEach((field, index) => {
    const where = `fields[${index}]`;
    if (!ANSWER_NAME.test(String(field.id ?? ''))) errors.push(`${where}: "id" must use letters, digits and _, starting with a letter or _.`);
    else if (ids.has(field.id)) errors.push(`${where}: the id "${field.id}" is used twice.`);
    ids.add(field.id);
    const kind = field.kind ?? 'text';
    if (!FIELD_KINDS.includes(kind)) errors.push(`${where}: "kind" must be text, image or video.`);
    const parsed = checkPath(`${where}.from`, field.from);
    if (parsed && kind !== 'text') {
      for (let rowIndex = 0; rowIndex < rows; rowIndex += 1) {
        const value = displayText(resolvePath(parsed, reader.cell(rowIndex, parsed.column), 0));
        if (value && !URL_LIKE.test(value.trim())) {
          errors.push(`${where}: "${field.from}" is not an address in HIT ${rowIndex + 1}. A ${kind} field needs a URL; use "kind": "text" for text.`);
          break;
        }
      }
    }
  });

  // 항목마다 하나씩인 목록을 [i] 없이 통째로 보이거나, 항목마다 다른 목록을 [0] 같은 고정 번호로 읽으면 다른 항목의 값을 보이게 된다.
  // Requester 가 "모든 항목에 같다"고 해도 데이터로 확인한다 (표본이 아니라 모든 HIT 에서 센다)
  if (tabs > 0) {
    const itemCounts = Array.from({ length: reader.rowCount }, (_, rowIndex) => {
      const over = parsePath(contract.repeat.over);
      const list = resolvePath(over, reader.cell(rowIndex, over.column), 0);
      return Array.isArray(list) ? list.length : 0;
    });
    fields.forEach((field, index) => {
      const parsed = parsePath(field.from);
      if (!parsed || !columns.has(parsed.column) || usesItem(parsed)) return;
      const first = parsed.steps[0];
      let whole = 0;
      let differs = 0;
      for (let rowIndex = 0; rowIndex < reader.rowCount; rowIndex += 1) {
        const cell = reader.cell(rowIndex, parsed.column);
        if (!Array.isArray(cell) || cell.length !== itemCounts[rowIndex] || cell.length < 2) continue;
        if (!first) whole += 1;
        else if ('index' in first && new Set(cell.map((value) => displayText(value))).size > 1) differs += 1;
      }
      const where = `fields[${index}].from`;
      if (whole > 0) errors.push(`${where}: "${field.from}" holds one value per item (${whole} HIT(s)), so it shows every item's value at once. Use "${parsed.column}[i]" to show each item's own value.`);
      if (differs > 0) errors.push(`${where}: "${field.from}" reads one fixed element, but the values of "${parsed.column}" differ between items in ${differs} of ${reader.rowCount} HIT(s), so some items would show another item's value. Use "${parsed.column}[i]"; if the request says the value is the same for every item, tell the requester in "message" that the data says otherwise.`);
    });
  }

  // questions: 문항
  const questions = questionsOf(contract);
  if (questions.length === 0) errors.push('"questions" must list at least one question.');
  const names = new Set();
  questions.forEach((question, index) => {
    const where = `questions[${index}]`;
    if (!ANSWER_NAME.test(String(question.name ?? ''))) errors.push(`${where}: "name" must use letters, digits and _, starting with a letter or _.`);
    else if (names.has(question.name)) errors.push(`${where}: the name "${question.name}" is used twice.`);
    names.add(question.name);
    if (!QUESTION_TYPES.includes(question.type)) errors.push(`${where}: "type" must be one of ${QUESTION_TYPES.join(', ')}.`);
    if (typeof question.header !== 'string' || question.header.trim() === '') errors.push(`${where}: "header" must be the question.`);
    if (question.per_item === true && !contract.repeat) errors.push(`${where}: "per_item" needs "repeat".`);
    if (['choice', 'item-choice'].includes(question.type)) {
      const values = optionPairs(question.options).map(([value]) => value);
      if (values.length < 2) errors.push(`${where}: a ${question.type} question needs at least two options.`);
      if (new Set(values).size !== values.length) errors.push(`${where}: option values must differ.`);
    }
    if (question.type === 'likert') {
      const min = question.min ?? 1;
      const max = question.max ?? 5;
      if (!Number.isInteger(min) || !Number.isInteger(max) || max <= min) errors.push(`${where}: "max" must be a whole number greater than "min".`);
    }
    if (['checklist', 'item-choice'].includes(question.type)) {
      if (Array.isArray(question.items)) {
        if (question.items.length === 0) errors.push(`${where}: "items" is empty.`);
      } else if (typeof question.items === 'string') {
        checkPath(`${where}.items`, question.items, { item: questionPerItem(contract, question) });
      } else errors.push(`${where}: a ${question.type} question needs "items": a path to a list, or a list of strings.`);
    }
  });

  // 영어: worker 에게 보일 글
  const texts = [['instructions', contract.instructions], ['repeat.label', contract.repeat?.label]];
  fields.forEach((field, index) => texts.push([`fields[${index}].label`, field.label]));
  questions.forEach((question, index) => {
    texts.push([`questions[${index}].header`, question.header], [`questions[${index}].placeholder`, question.placeholder], [`questions[${index}].min_label`, question.min_label], [`questions[${index}].max_label`, question.max_label]);
    optionPairs(question.options).forEach(([, label], o) => texts.push([`questions[${index}].options[${o}]`, label]));
    if (Array.isArray(question.items)) question.items.forEach((item, o) => texts.push([`questions[${index}].items[${o}]`, isObject(item) ? item.text : item]));
  });
  const foreign = texts.filter(([, text]) => typeof text === 'string' && NOT_ENGLISH.test(text)).map(([where]) => where);
  if (foreign.length > 0) errors.push(`Write every text workers see in English: ${foreign.slice(0, 5).join(', ')}${foreign.length > 5 ? ` and ${foreign.length - 5} more` : ''}.`);

  // 정답 컬럼은 화면에 쓰지 않는다
  const sources = answerSources(contract);
  const shownPaths = [...fields.map((field, index) => [`fields[${index}].from`, field.from]), ...questions.filter((q) => typeof q.items === 'string').map((q) => [`questions "${q.name}" items`, q.items])];
  for (const [where, path] of shownPaths) {
    const column = parsePath(path)?.column;
    if (!column) continue;
    if (sources.includes(column)) errors.push(`${where}: "${column}" holds the answers or attention checks. Never show it to workers.`);
    else if (ANSWER_LIKE.test(column)) errors.push(`${where}: the column "${column}" looks like it holds answers. Leave it off the page, or declare it in "reference" if it is the answer key.`);
  }

  // 대조 기준
  const byName = new Map(questions.map((q) => [q.name, q]));
  referencesOf(contract).forEach((ref, index) => {
    const where = `reference[${index}]`;
    const question = byName.get(ref.question);
    if (!question) {
      errors.push(`${where}: "question" must name a question.`);
      return;
    }
    if (!JUDGED_TYPES.includes(question.type)) errors.push(`${where}: a ${question.type} question has no labels to compare with.`);
    const forms = ['value', 'map', 'selected'].filter((form) => ref[form] !== undefined);
    if (forms.length !== 1) {
      errors.push(`${where}: give exactly one of "value", "map" or "selected".`);
      return;
    }
    const form = forms[0];
    if (form !== 'value' && typeof ref.key !== 'string') errors.push(`${where}: "${form}" needs "key".`);
    if (form === 'selected' && (typeof ref.item !== 'string' || ref.yes === undefined || ref.no === undefined)) errors.push(`${where}: "selected" needs "item", "yes" and "no".`);
    checkPath(`${where}.${form}`, ref[form]);
  });
  if (contract.attention !== undefined) {
    const { attention } = contract;
    const question = byName.get(attention?.question);
    if (!isObject(attention)) errors.push('"attention" must be {"flag": "<path>", "question": "<name>", "expected": "<value>"}.');
    else {
      checkPath('attention.flag', attention.flag);
      if (!question || !JUDGED_TYPES.includes(question.type)) errors.push('attention.question must name a choice, likert, checklist or item-choice question.');
      else if (attention.expected !== undefined && !allowedValues(question).includes(String(attention.expected))) errors.push(`attention.expected: "${attention.expected}" is not a value of "${question.name}" (${allowedValues(question).join(', ')}).`);
    }
  }
  if (errors.length === 0 && referencesOf(contract).length > 0) {
    // 앞쪽 HIT 에서 라벨이 실제로 읽히고 문항의 값에 들어 있는지 본다
    for (const ref of referencesOf(contract)) {
      const question = byName.get(ref.question);
      const one = { ...contract, reference: [ref] };
      const seen = new Set();
      let answers = 0;
      for (let rowIndex = 0; rowIndex < rows; rowIndex += 1) {
        const labels = referenceValues(one, tabs, reader, rowIndex);
        answers += labels.answerCount;
        Object.values(labels.values).forEach((value) => seen.add(value));
      }
      const allowed = allowedValues(question).map((value) => value.toLowerCase());
      const outside = [...seen].filter((value) => !allowed.includes(value.toLowerCase()));
      if (seen.size === 0) errors.push(`reference for "${ref.question}": no labels were found in the first ${rows} HIT(s). Check the path and the key.`);
      else if (outside.length > 0) errors.push(`reference for "${ref.question}": label(s) ${outside.slice(0, 5).map((v) => JSON.stringify(v)).join(', ')} are not values of the question (${allowedValues(question).join(', ')}). Use the labels of the data as option values.`);
      else if (answers === 0) warnings.push(`reference for "${ref.question}" covers no answers.`);
    }
  }
  return { errors: [...new Set(errors)], warnings, tabs };
}

// ---- 조립 ---------------------------------------------------------------------------------------

function fieldLines(field, tab) {
  const column = `\${${fieldColumn(field, tab)}}`;
  const label = attr(field.label ?? field.id);
  if ((field.kind ?? 'text') === 'text') return [`<ann-text label="${label}">${column}</ann-text>`];
  return [`<ann-${field.kind} label="${label}" src="${column}"></ann-${field.kind}>`];
}

function questionLines(contract, question, tab) {
  const name = answerBase(question, tab);
  const required = question.type === 'text' ? question.required === true : question.required !== false;
  const head = `name="${name}" header="${attr(question.header)}"${required ? ' required' : ''}`;
  const options = () => optionPairs(question.options).map(([value, label]) => `  <ann-option value="${attr(value)}">${escapeHtml(label)}</ann-option>`);
  const items = () => (Array.isArray(question.items)
    ? question.items.map((item) => (isObject(item) ? `  <ann-item${item.key !== undefined ? ` key="${attr(item.key)}"` : ''}>${escapeHtml(String(item.text ?? ''))}</ann-item>` : `  <ann-item>${escapeHtml(String(item))}</ann-item>`))
    : [`  <script type="application/json">\${${itemsColumn(question, tab)}}</script>`]);
  switch (question.type) {
    case 'choice':
      return [`<ann-choice ${head}${question.layout === 'horizontal' ? ' layout="horizontal"' : ''}>`, ...options(), '</ann-choice>'];
    case 'likert':
      return [`<ann-likert ${head} min="${question.min ?? 1}" max="${question.max ?? 5}"${question.min_label ? ` min-label="${attr(question.min_label)}"` : ''}${question.max_label ? ` max-label="${attr(question.max_label)}"` : ''}></ann-likert>`];
    case 'checklist':
      return [`<ann-checklist ${head} checked-value="${attr(question.checked ?? 'yes')}" unchecked-value="${attr(question.unchecked ?? 'no')}">`, ...items(), '</ann-checklist>'];
    case 'item-choice':
      return [`<ann-item-choice ${head}>`, ...options(), ...items(), '</ann-item-choice>'];
    default:
      return [`<ann-textarea ${head}${question.placeholder ? ` placeholder="${attr(question.placeholder)}"` : ''}></ann-textarea>`];
  }
}

/** 계약의 기본 템플릿: 한 번만 보일 값 → 항목마다의 값과 문항(탭) → 한 번만 묻는 문항. 배치를 바꾸는 것은 Agent 의 HTML 이다. */
export function buildContractTemplate(contract, tabs) {
  const fields = fieldsOf(contract);
  const questions = questionsOf(contract);
  const indent = (lines, depth) => lines.map((line) => `${'  '.repeat(depth)}${line}`);
  const lines = [`<script src="${ELEMENTS_SCRIPT}"></script>`, '', '<ann-form>', '  <ann-instructions>', `    <p>${escapeHtml(contract.instructions ?? '')}</p>`, '  </ann-instructions>', ''];
  for (const field of fields.filter((f) => !fieldPerItem(f))) lines.push(...indent(fieldLines(field, null), 1));
  const itemFields = fields.filter(fieldPerItem);
  const itemQuestions = questions.filter((q) => questionPerItem(contract, q));
  if (contract.repeat && tabs > 0 && (itemFields.length > 0 || itemQuestions.length > 0)) {
    lines.push('', '  <ann-tabs>');
    for (let tab = 0; tab < tabs; tab += 1) {
      lines.push(`    <ann-tab header="${attr(contract.repeat.label ?? 'Item')} ${tab + 1}">`);
      for (const field of itemFields) lines.push(...indent(fieldLines(field, tab), 3));
      for (const question of itemQuestions) lines.push(...indent(questionLines(contract, question, tab), 3));
      lines.push('    </ann-tab>');
    }
    lines.push('  </ann-tabs>');
  }
  const onceQuestions = questions.filter((q) => !questionPerItem(contract, q));
  if (onceQuestions.length > 0) lines.push('');
  for (const question of onceQuestions) lines.push(...indent(questionLines(contract, question, null), 1));
  lines.push('</ann-form>', '');
  return lines.join('\n');
}

/** HIT 하나의 게시용 행. */
export function contractRow(contract, tabs, reader, rowIndex) {
  const fields = fieldsOf(contract);
  const questions = questionsOf(contract);
  const consumed = new Set([...fields.map((f) => f.from), ...questions.filter((q) => typeof q.items === 'string').map((q) => q.items)].map((path) => parsePath(path)?.column).filter(Boolean));
  const row = {};
  for (const column of reader.columns) if (!consumed.has(column)) row[column] = reader.raw(rowIndex, column);
  for (const field of fields) {
    for (const tab of tabIndexes(fieldPerItem(field), tabs)) {
      const text = displayText(readPath(field.from, reader, rowIndex, tab));
      row[fieldColumn(field, tab)] = (field.kind ?? 'text') === 'text' ? escapeHtml(text) : text.replace(/"/g, '%22');
    }
  }
  for (const question of questions.filter((q) => typeof q.items === 'string')) {
    for (const tab of tabIndexes(questionPerItem(contract, question), tabs)) row[itemsColumn(question, tab)] = itemsCell(readPath(question.items, reader, rowIndex, tab));
  }
  if (referencesOf(contract).length > 0) row[REFERENCE_COLUMN] = JSON.stringify(referenceValues(contract, tabs, reader, rowIndex).values);
  if (contract.attention?.expected !== undefined) row[ATTENTION_COLUMN] = JSON.stringify(attentionValues(contract, tabs, reader, rowIndex));
  return row;
}

/** html-harness 가 쓰는 계약. 계약 검사를 통과하지 못하면 예외다. */
export function harnessContract(contract, reader) {
  const check = checkContract(contract, reader);
  if (check.errors.length > 0) throw new Error(`The contract does not pass its checks: ${check.errors.join(' ')}`);
  const html = buildContractTemplate(contract, check.tabs);
  const rows = Array.from({ length: reader.rowCount }, (_, rowIndex) => contractRow(contract, check.tabs, reader, rowIndex));
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const shown = extractPlaceholders(html);
  return {
    html,
    data: { fileName: 'hits.json', columns, rows, hadBom: false, warnings: [] },
    tabs: check.tabs,
    shown,
    hidden: columns.filter((column) => !shown.includes(column)),
    roles: Object.fromEntries([...placeholderRoles(html)].map(([name, set]) => [name, [...set][0]])),
    questions: lintLayout(html).questions.map(({ tag, name }) => ({ tag, name })),
    answerColumns: [REFERENCE_COLUMN, ATTENTION_COLUMN, ...answerSources(contract)].filter((column) => columns.includes(column)),
  };
}

/** 계약의 task 종류: 영상 값이 있으면 video, 이미지 값이 있으면 vision, 아니면 text. Project 속성의 기본값을 고르는 데 쓴다. */
export function contractTaskType(contract) {
  const kinds = fieldsOf(contract).map((field) => field.kind ?? 'text');
  return kinds.includes('video') ? 'video' : kinds.includes('image') ? 'vision' : 'text';
}

/**
 * 화면에 보일 계약의 요약. Requester 가 Agent 가 무엇을 정했는지 읽고 확인하는 데 쓴다.
 * → { values: [{ label, from, kind, perItem }], questions: [{ name, type, header, answers, perItem, compared, attention }], itemLabel }
 */
export function contractOutline(contract) {
  const references = new Set(referencesOf(contract).map((ref) => ref.question));
  const answersOf = (question) => {
    if (question.type === 'likert') return `${question.min ?? 1} to ${question.max ?? 5}${question.min_label || question.max_label ? ` (${question.min_label ?? ''} … ${question.max_label ?? ''})` : ''}`;
    if (question.type === 'text') return 'written answer';
    const items = Array.isArray(question.items) ? `items: ${question.items.map((item) => (isObject(item) ? item.text : item)).join(', ')}` : question.items ? `items from ${question.items}` : '';
    const options = question.type === 'checklist' ? `${question.checked ?? 'yes'} / ${question.unchecked ?? 'no'} for each item` : optionPairs(question.options).map(([, label]) => label).join(' / ');
    return [options, items].filter(Boolean).join('; ');
  };
  return {
    itemLabel: contract?.repeat ? `${contract.repeat.label ?? 'Item'} (one per element of ${contract.repeat.over})` : null,
    values: fieldsOf(contract).map((field) => ({ label: field.label ?? field.id, from: field.from, kind: field.kind ?? 'text', perItem: fieldPerItem(field) })),
    questions: questionsOf(contract).map((question) => ({
      name: question.name,
      type: question.type,
      header: question.header,
      answers: answersOf(question),
      perItem: questionPerItem(contract, question),
      compared: references.has(question.name),
      attention: contract?.attention?.question === question.name,
    })),
  };
}

/** 게시 설정에 얹을 값 (bindingSettings 와 같은 모양). */
export function contractSettings(contract) {
  const settings = {};
  if (referencesOf(contract).length > 0) settings.referenceColumn = REFERENCE_COLUMN;
  if (contract.attention?.expected !== undefined) Object.assign(settings, { attentionEnabled: true, attentionMode: 'column', attentionColumn: ATTENTION_COLUMN, attentionMinRatio: 1 });
  return settings;
}

/**
 * Agent 에게 계약을 묻고 검사한다. 오류가 있으면 오류와 이전 답을 붙여 maxAttempts 번까지 다시 묻는다.
 * send(body) → { contract, message, cannot?, usage? }, check(contract) → { errors }.
 */
export async function requestContract({ send, check, request, maxAttempts = 3 }) {
  let previous = null;
  let errors = [];
  const usage = { calls: 0 };
  const history = [];
  let last = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const reply = await send(errors.length > 0 ? { ...request, previous, errors } : request);
    last = reply;
    for (const [key, value] of Object.entries(reply.usage ?? {})) {
      if (typeof value === 'number') usage[key] = (usage[key] ?? 0) + value;
    }
    const common = { message: reply.message ?? null, attempts: attempt, usage, history };
    if (reply.cannot) {
      history.push({ attempt, cannot: reply.cannot, errors: [] });
      return { ...common, contract: null, cannot: reply.cannot, errors: [] };
    }
    errors = check(reply.contract).errors;
    history.push({ attempt, errors });
    if (errors.length === 0) return { ...common, contract: reply.contract, cannot: null, errors };
    previous = reply.contract;
  }
  return { contract: last.contract, message: last.message ?? null, cannot: null, errors, attempts: maxAttempts, usage, history };
}

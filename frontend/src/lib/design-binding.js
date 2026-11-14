// 이미 HIT 로 묶인 데이터를 rough design 의 칸에 넣는다. binding 은 "어떤 값이 어느 칸에 들어갈지"만 적은 JSON 이고,
// 값 꺼내기와 템플릿 조립은 코드가 맡는다. 지금은 사람이 binding 을 쓰고, 다음 단계에서 LLM 이 같은 형식을 쓴다.
//   {
//     "design": "item-list", "task_type": "text",
//     "repeat": { "over": "retrieved_chunk", "label": "Chunk" },      HIT 안의 항목마다 탭 하나. 없으면 HIT 당 화면 하나다
//     "slots": {
//       "data": { "label": "Chunk", "from": "retrieved_chunk[i]" },   데이터 칸. 여러 값을 보이려면 배열로 쓴다. kind 는 image, video, text
//       "item-choice": { "header": "…", "items": "atomic_facts[i]", "options": [["yes", "Yes"], "no"] },   항목은 경로 또는 글 목록
//       "choice": { "header": "…", "options": [["yes", "Yes"], "no"] },
//       "compare": { "header": "…" }, "free-text": { "header": "…", "placeholder": "…" }
//     },
//     "context": [{ "label": "Question", "from": "question" }],        어느 칸에도 안 맞지만 worker 가 읽어야 하는 값. 칸들 위에 보인다
//     "reference": { "selected": "labels", "key": "Chunk {i}", "item": "Fact {n}", "yes": "supported", "no": "not_supported" },
//     "attention": { "flag": "attention_check[i]", "expected": "not_supported" },  expected 가 있으면 게시 때 판정한다
//     "instructions": "…",                                            없으면 task 종류의 예시 안내문
//     "layout": { "rows": [{ "columns": "2fr 3fr", "slots": ["item-choice", ["data", "free-text"]] }] }   없으면 가안의 배치
//   }
// 경로는 컬럼 이름 뒤에 [i](repeat 의 현재 항목), [숫자], .키 를 붙인다. 셀은 JSON 이나 Python 리터럴이어도 구조로 읽는다.
// 게시용 데이터는 칸마다 컬럼(slot_data_1 …)을 새로 만들고, binding 이 쓰지 않은 컬럼은 그대로 둔다.
// reference 는 데이터의 라벨을 답 이름별로 풀어 slot_reference 컬럼에, attention.expected 는 slot_attention 컬럼에 넣어 게시 설정으로 잇는다.
//   { "value": "<경로>" }                         칸마다 라벨이 있을 때. item-choice 면 항목 순서의 목록
//   { "map": "<경로>", "key": "general_{i}_{n}" }  키에 번호가 든 객체. {i} 는 탭 번호(0부터), {n} 은 항목 번호(1부터)
//   { "selected": "<경로>", "key": "Chunk {i}", "item": "Fact {n}", "yes": "…", "no": "…" }  고른 항목만 적힌 목록
// binding 에 없는 문항 칸은 예시 문항을 쓰고 경고한다. 가안을 바꾸면 adaptBinding 이 값을 새 칸으로 옮긴다.
// layout 은 가안의 rows 를 대신한다. checkBinding 이 돌려주는 design 에 이미 반영되어 있어 조립과 폼은 차이를 모른다.
// columns 는 템플릿의 속성으로 들어가므로 layoutErrors 가 형식을 좁게 검사한다.
// LLM 에게는 summarizeData 의 요약만 보내고, requestBinding 이 답을 checkBinding 으로 검사해 오류를 붙여 다시 묻는다.

import { DATA_KINDS, SLOT_LABELS, assembleTemplate, choiceLines, compareOptions, dataLines, defaultKind, freeTextLines, instructionsFor, itemChoiceLines, roughDesignById, taskContent, taskTypeById } from './rough-designs.js';

const DATA_SLOTS = ['data', 'data-a', 'data-b'];
const ANSWER_SLOTS = ['choice', 'compare', 'item-choice', 'free-text'];
const SLOT_NAMES = Object.keys(SLOT_LABELS);
const JUDGED_SLOTS = ['item-choice', 'choice', 'compare']; // 대조 기준과 attention 이 가리키는 문항 칸. 앞의 것이 먼저다
const REFERENCE_COLUMN = 'slot_reference';
const ATTENTION_COLUMN = 'slot_attention';
const URL_LIKE = /^(https?:\/\/|data:|\.{0,2}\/)|\.(png|jpe?g|gif|webp|avif|svg|mp4|webm|mov|m4v|ogv)([?#]|$)/i;
const CHECK_ROWS = 20; // 라벨과 주소의 모양을 볼 HIT 수
const NOT_ENGLISH = /[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u; // worker 에게 보일 글은 영어로 쓴다
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PATH = /^([^\s[\].]+)((?:\[(?:i|\d+)\]|\.[^\s[\].]+)*)$/;
const STEP = /\[(i|\d+)\]|\.([^\s[\].]+)/g;
const SKIP_COLUMN = /(^|_)(q?id|idx|ids|index|counts?|check|reasoning|reason|label|gold|expected)$/i;
const LAYOUT_ROWS = 6;
const LAYOUT_COLUMNS = 3;
const COLUMN_WIDTHS = /^[1-9]\d?fr( [1-9]\d?fr)*$/;

// ---- 셀 값 --------------------------------------------------------------------------------------

/** Python 리터럴 읽기 (str, 숫자, True/False/None, list, tuple, dict). 예전 MTurk 입력의 셀이 이 모양이다. 못 읽으면 예외를 던진다. */
function parsePythonLiteral(text) {
  let at = 0;
  const fail = () => {
    throw new SyntaxError(`Unexpected input at ${at}`);
  };
  const skip = () => {
    while (at < text.length && /\s/.test(text[at])) at += 1;
  };
  const string = () => {
    const quote = text[at];
    at += 1;
    let out = '';
    while (at < text.length && text[at] !== quote) {
      if (text[at] !== '\\') {
        out += text[at];
        at += 1;
        continue;
      }
      const next = text[at + 1];
      at += 2;
      const simple = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', 0: '\0', '\\': '\\', "'": "'", '"': '"', '\n': '' };
      if (next in simple) out += simple[next];
      else if (next === 'x' || next === 'u') {
        const size = next === 'x' ? 2 : 4;
        const code = Number.parseInt(text.slice(at, at + size), 16);
        if (Number.isNaN(code)) fail();
        out += String.fromCharCode(code);
        at += size;
      } else out += `\\${next}`;
    }
    if (at >= text.length) fail();
    at += 1;
    return out;
  };
  const list = (close) => {
    at += 1;
    const out = [];
    for (;;) {
      skip();
      if (text[at] === close) {
        at += 1;
        return out;
      }
      out.push(value());
      skip();
      if (text[at] === ',') at += 1;
      else if (text[at] !== close) fail();
    }
  };
  const dict = () => {
    at += 1;
    const out = {};
    for (;;) {
      skip();
      if (text[at] === '}') {
        at += 1;
        return out;
      }
      const key = value();
      skip();
      if (text[at] !== ':') fail();
      at += 1;
      out[String(key)] = value();
      skip();
      if (text[at] === ',') at += 1;
      else if (text[at] !== '}') fail();
    }
  };
  function value() {
    skip();
    const ch = text[at];
    if (ch === "'" || ch === '"') return string();
    if (ch === '[') return list(']');
    if (ch === '(') return list(')');
    if (ch === '{') return dict();
    const word = /^(True|False|None|-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)/.exec(text.slice(at, at + 40));
    if (!word) fail();
    at += word[0].length;
    if (word[0] === 'True') return true;
    if (word[0] === 'False') return false;
    if (word[0] === 'None') return null;
    return Number(word[0]);
  }
  const result = value();
  skip();
  if (at < text.length) fail();
  return result;
}

/** 셀 글을 값으로 읽는다. 목록이나 객체로 보이는 글만 JSON → Python 리터럴 순서로 풀고, 그 밖의 글은 그대로 둔다. */
export function parseCell(text) {
  if (typeof text !== 'string' || !/^\s*[[{(]/.test(text)) return text ?? '';
  try {
    return JSON.parse(text);
  } catch {
    // Python 리터럴일 수 있다
  }
  try {
    return parsePythonLiteral(text);
  } catch {
    return text;
  }
}

/** 경로 글 → { column, steps } 또는 null. */
export function parsePath(path) {
  const match = PATH.exec(String(path ?? ''));
  if (!match) return null;
  const steps = [...match[2].matchAll(STEP)].map((step) => (step[2] !== undefined ? { key: step[2] } : { index: step[1] === 'i' ? 'i' : Number(step[1]) }));
  return { column: match[1], steps };
}

function resolve(parsed, cell, i) {
  let value = cell;
  for (const step of parsed.steps) {
    if (value === null || value === undefined) return undefined;
    if ('key' in step) value = typeof value === 'object' && !Array.isArray(value) ? value[step.key] : undefined;
    else value = Array.isArray(value) ? value[step.index === 'i' ? i : step.index] : undefined;
  }
  return value;
}

/** 칸에 넣을 글. 목록은 줄로, 객체는 JSON 으로 보인다. */
function displayText(value) {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map(displayText).join('\n');
  return typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
}

const escapeHtml = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** <script> 안에 넣어도 안전한 항목 목록. */
function itemsCell(value) {
  const items = (Array.isArray(value) ? value : value === null || value === undefined || value === '' ? [] : [value]).map((item) => (typeof item === 'object' && item !== null ? item : String(item)));
  return JSON.stringify(items).replace(/</g, '\\u003c');
}

// 가안 없이 쓰는 자유 계약(lib/task-contract.js)도 같은 방식으로 값을 읽고 넣는다
export { resolve as resolvePath, displayText, escapeHtml, itemsCell, URL_LIKE, NOT_ENGLISH, NAME as ANSWER_NAME };

/** 행의 셀을 한 번씩만 푸는 읽기 도구. 수 MB 의 데이터를 편집 중에 되풀이해 읽는다. */
export function dataReader(data) {
  const cache = new Map();
  return {
    columns: data.columns,
    rowCount: data.rows.length,
    raw: (rowIndex, column) => data.rows[rowIndex]?.[column] ?? '',
    cell(rowIndex, column) {
      const key = `${rowIndex}\u0000${column}`;
      if (!cache.has(key)) cache.set(key, parseCell(data.rows[rowIndex]?.[column]));
      return cache.get(key);
    },
  };
}

// ---- binding 읽기 --------------------------------------------------------------------------------

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const fieldsOf = (spec) => (Array.isArray(spec) ? spec : spec === undefined || spec === null ? [] : [spec]);

function slotsOf(design) {
  return design.rows.flatMap((row) => row.slots.flat());
}

/** binding 의 layout 이 어긋난 곳들. 없으면 빈 목록이다. */
export function layoutErrors(layout) {
  if (!isObject(layout) || !Array.isArray(layout.rows) || layout.rows.length === 0) return ['"layout" must be an object with a list of "rows".'];
  if (layout.rows.length > LAYOUT_ROWS) return [`"layout" can have at most ${LAYOUT_ROWS} rows.`];
  const errors = [];
  const seen = [];
  layout.rows.forEach((row, index) => {
    const where = `layout.rows[${index}]`;
    if (!isObject(row) || !Array.isArray(row.slots) || row.slots.length === 0) {
      errors.push(`${where} must have a list of "slots".`);
      return;
    }
    if (row.slots.length > LAYOUT_COLUMNS) errors.push(`${where} has ${row.slots.length} columns. A row can have at most ${LAYOUT_COLUMNS}.`);
    for (const cell of row.slots) {
      const stack = Array.isArray(cell) ? cell : [cell];
      if (stack.length === 0) errors.push(`${where} has an empty column.`);
      for (const slot of stack) {
        if (!SLOT_NAMES.includes(slot)) errors.push(`${where}: ${JSON.stringify(slot)} is not a slot. The slots are ${SLOT_NAMES.join(', ')}.`);
        else if (seen.includes(slot)) errors.push(`${where}: slot "${slot}" is placed twice. Each slot can appear once.`);
        else seen.push(slot);
      }
    }
    if (row.columns !== undefined && (typeof row.columns !== 'string' || !COLUMN_WIDTHS.test(row.columns) || row.columns.split(' ').length !== row.slots.length)) {
      errors.push(`${where}: "columns" must give one width per column, like "3fr 2fr" (got ${JSON.stringify(row.columns)}).`);
    }
  });
  if (errors.length > 0) return errors;
  const pair = ['data-a', 'data-b'].filter((slot) => seen.includes(slot));
  if (pair.length === 1) errors.push('"layout": "data-a" and "data-b" must be placed together.');
  if (seen.includes('compare') && pair.length < 2) errors.push('"layout": "compare" picks between "data-a" and "data-b", so place them too.');
  if (!seen.some((slot) => DATA_SLOTS.includes(slot))) errors.push('"layout" must place at least one data slot.');
  if (!seen.some((slot) => ANSWER_SLOTS.includes(slot))) errors.push('"layout" must place at least one answer slot.');
  return errors;
}

const withLayout = (design, layout) => ({ ...design, rows: layout.rows, customLayout: true });

/** binding 이 실제로 쓰는 배치의 가안. layout 이 틀렸으면 가안 그대로다. */
function designOf(binding) {
  const design = roughDesignById(binding.design);
  return design && binding.layout !== undefined && layoutErrors(binding.layout).length === 0 ? withLayout(design, binding.layout) : design;
}

function optionPairs(options) {
  return (Array.isArray(options) ? options : []).map((option) => (Array.isArray(option) ? [String(option[0]), String(option[1] ?? option[0])] : [String(option), String(option)]));
}

/** binding 을 칸마다 정리한다. 없는 문항 칸은 task 종류의 예시로 채우고 sampled 에 적는다. */
function normalize(binding, design, taskType) {
  const content = taskContent(taskType);
  const slots = {};
  const sampled = [];
  for (const slot of slotsOf(design)) {
    const spec = binding.slots?.[slot];
    if (DATA_SLOTS.includes(slot)) {
      slots[slot] = fieldsOf(spec);
      continue;
    }
    if (!spec) sampled.push(slot);
    if (slot === 'choice') {
      slots[slot] = { name: spec?.name ?? content.choice.name, header: spec?.header ?? content.choice.header, options: spec?.options ? optionPairs(spec.options) : content.choice.options };
    } else if (slot === 'compare') {
      slots[slot] = { name: spec?.name ?? content.compare.name, header: spec?.header ?? content.compare.header, options: spec?.options ? optionPairs(spec.options) : compareOptions(content.label) };
    } else if (slot === 'item-choice') {
      slots[slot] = { name: spec?.name ?? content.itemChoice.name, header: spec?.header ?? content.itemChoice.header, items: spec?.items ?? content.itemChoice.items, options: spec?.options ? optionPairs(spec.options) : content.itemChoice.options };
    } else {
      slots[slot] = { name: spec?.name ?? content.freeText.name, header: spec?.header ?? content.freeText.header, placeholder: spec?.placeholder ?? content.freeText.placeholder };
    }
  }
  return { slots, sampled, context: fieldsOf(binding.context) };
}

/** 문항 칸의 답 이름들. 항목별 칸은 항목마다 하나다. */
function answerNames(slot, spec, tabIndex, itemCount) {
  const base = `${spec.name}${tabIndex === null ? '' : `_${tabIndex + 1}`}`;
  return slot === 'item-choice' ? Array.from({ length: itemCount }, (_, index) => `${base}_${index + 1}`) : [base];
}

function judgedSlot(design) {
  return JUDGED_SLOTS.find((slot) => slotsOf(design).includes(slot)) ?? null;
}

const fillKey = (template, tabIndex, itemNumber) => String(template).replace(/\{i\}/g, String(tabIndex ?? 0)).replace(/\{n\}/g, String(itemNumber));
const asItems = (value) => (Array.isArray(value) ? value : value === null || value === undefined || value === '' ? [] : [value]);

/** binding 이 경로로 읽는 모든 곳 [{ where, path }]. */
function pathsOf(binding, slots, context = []) {
  const paths = [];
  if (binding.repeat) paths.push({ where: 'repeat.over', path: binding.repeat.over });
  context.forEach((field, index) => paths.push({ where: `context[${index}].from`, path: field?.from }));
  for (const [slot, spec] of Object.entries(slots)) {
    if (DATA_SLOTS.includes(slot)) spec.forEach((field, index) => paths.push({ where: `slots.${slot}${spec.length > 1 ? `[${index}]` : ''}.from`, path: field?.from }));
    else if (slot === 'item-choice' && typeof spec.items === 'string') paths.push({ where: 'slots.item-choice.items', path: spec.items });
  }
  return paths;
}

/** repeat 대상의 HIT 별 항목 수. 목록이 아닌 행은 null 이다. */
function repeatCounts(binding, reader) {
  const parsed = parsePath(binding.repeat.over);
  return Array.from({ length: reader.rowCount }, (_, rowIndex) => {
    const value = resolve(parsed, reader.cell(rowIndex, parsed.column), 0);
    return Array.isArray(value) ? value.length : null;
  });
}

/**
 * binding 을 검사한다 → { errors, warnings, design, taskType, tabs }. errors 가 있으면 미리보기와 저장을 막는다.
 * tabs 는 HIT 당 탭 수다 (repeat 가 없으면 0). HIT 마다 다르면 가장 큰 수이고 경고한다.
 */
export function checkBinding(binding, reader) {
  const errors = [];
  const warnings = [];
  const result = { errors, warnings, design: null, taskType: null, tabs: 0 };
  if (!isObject(binding)) {
    errors.push('The binding must be a JSON object.');
    return result;
  }
  const design = roughDesignById(binding.design);
  const taskType = taskTypeById(binding.task_type);
  if (!design) errors.push(`"design" must be one of the rough designs, not ${JSON.stringify(binding.design)}.`);
  if (!taskType) errors.push(`"task_type" must be vision, video or text, not ${JSON.stringify(binding.task_type)}.`);
  if (binding.slots !== undefined && !isObject(binding.slots)) errors.push('"slots" must be an object.');
  if (binding.repeat !== undefined && !isObject(binding.repeat)) errors.push('"repeat" must be an object like {"over": "column"}.');
  if (errors.length > 0) return result;
  result.design = design;
  result.taskType = taskType;
  if (binding.layout !== undefined) {
    errors.push(...layoutErrors(binding.layout));
    if (errors.length > 0) return result;
    result.design = withLayout(design, binding.layout);
  }
  const designed = result.design;

  const designSlots = slotsOf(designed);
  for (const slot of Object.keys(binding.slots ?? {})) {
    if (!designSlots.includes(slot)) errors.push(`The ${design.title} design has no slot "${slot}". Its slots are ${designSlots.join(', ')}.`);
  }
  if (design.tabs && !binding.repeat) errors.push(`The ${design.title} design shows one item per tab, so it needs "repeat" over a list column.`);
  const { slots, sampled, context } = normalize(binding, designed, taskType);
  for (const slot of designSlots.filter((name) => DATA_SLOTS.includes(name))) {
    if (slots[slot].length === 0) errors.push(`Slot "${slot}" has no data. Add {"from": "<column>"} to it.`);
  }
  for (const slot of ANSWER_SLOTS.filter((name) => designSlots.includes(name))) {
    const { name, options, items } = slots[slot];
    if (!NAME.test(String(name))) errors.push(`Slot "${slot}": "name" must use letters, digits and _, starting with a letter or _.`);
    if (options && options.length < 2) errors.push(`Slot "${slot}" needs at least two options.`);
    if (slot === 'item-choice' && typeof items !== 'string' && !Array.isArray(items)) errors.push('Slot "item-choice": "items" must be a path or a list.');
  }
  for (const { where, path } of pathsOf(binding, slots, context)) {
    const parsed = parsePath(path);
    if (!parsed) errors.push(`${where}: ${JSON.stringify(path)} is not a path. Write a column name, optionally followed by [i], [0] or .key.`);
    else if (!reader.columns.includes(parsed.column)) errors.push(`${where}: the data has no column "${parsed.column}".`);
    else if (!binding.repeat && parsed.steps.some((step) => step.index === 'i')) errors.push(`${where}: [i] needs "repeat".`);
  }
  if (binding.attention?.flag !== undefined) {
    const parsed = parsePath(binding.attention.flag);
    if (!parsed || !reader.columns.includes(parsed.column)) errors.push(`attention.flag: ${JSON.stringify(binding.attention.flag)} is not a path to a column of the data.`);
  }
  if (errors.length > 0) return result;

  if (binding.repeat) {
    const counts = repeatCounts(binding, reader);
    const bad = counts.flatMap((count, index) => (count === null ? [index + 1] : []));
    if (bad.length > 0) {
      errors.push(`repeat.over: "${binding.repeat.over}" is not a list in ${bad.length} HIT(s), starting with HIT ${bad[0]}.`);
      return result;
    }
    result.tabs = Math.max(...counts);
    if (result.tabs === 0) errors.push(`repeat.over: "${binding.repeat.over}" is empty in every HIT.`);
    else if (Math.min(...counts) !== result.tabs) warnings.push(`HITs have different numbers of items (${Math.min(...counts)} to ${result.tabs}). Shorter HITs hide the tabs they do not need.`);
    checkFixedPaths({ binding, slots, context, reader, counts, errors });
  }
  if (errors.length > 0) return result;
  checkLanguage(binding, errors);
  checkKinds({ slots, context, taskType, binding, reader, tabs: result.tabs, errors });
  checkJudged({ binding, design: designed, slots, reader, tabs: result.tabs, errors, warnings });
  for (const slot of sampled) warnings.push(`Slot "${slot}" has no binding, so the example question is shown. Replace it before you publish.`);
  return result;
}

const distinctCount = (list) => new Set(list.map((value) => JSON.stringify(value))).size;

/**
 * 탭과 길이가 같은 목록을 [0] 처럼 고정 번호로 읽는데 값이 탭마다 다른 곳. 그대로 두면 일부 탭에 다른 탭의 값이 보이고,
 * 경로는 맞으므로 다른 검사로는 드러나지 않는다. LLM 은 앞쪽 표본만 보고 값이 모두 같다고 짐작하기 쉽다.
 */
function checkFixedPaths({ binding, slots, context, reader, counts, errors }) {
  for (const { where, path } of pathsOf(binding, slots, context)) {
    if (where === 'repeat.over') continue;
    const parsed = parsePath(path);
    const at = parsed.steps.findIndex((step) => 'index' in step);
    if (at < 0 || parsed.steps[at].index === 'i') continue;
    const list = { column: parsed.column, steps: parsed.steps.slice(0, at) };
    const differing = counts.filter((count, rowIndex) => {
      const value = resolve(list, reader.cell(rowIndex, list.column), 0);
      return Array.isArray(value) && value.length === count && distinctCount(value) > 1;
    }).length;
    if (differing > 0) errors.push(`${where}: "${path}" shows the same element in every tab, but this list differs between tabs in ${differing} HIT(s). Use [i] so that each tab shows its own value.`);
  }
}

/** binding 에 직접 쓴 글(안내문, 문항, 라벨, 선택지)은 영어여야 한다. 데이터의 값은 보지 않는다. */
function checkLanguage(binding, errors) {
  const texts = [['instructions', binding.instructions], ['repeat.label', binding.repeat?.label]];
  fieldsOf(binding.context).forEach((field, index) => texts.push([`context[${index}].label`, field?.label]));
  for (const [slot, spec] of Object.entries(binding.slots ?? {})) {
    if (DATA_SLOTS.includes(slot)) fieldsOf(spec).forEach((field, index) => texts.push([`slots.${slot}[${index}].label`, field?.label]));
    else {
      texts.push([`slots.${slot}.header`, spec?.header], [`slots.${slot}.placeholder`, spec?.placeholder]);
      optionPairs(spec?.options).forEach(([value, label], index) => texts.push([`slots.${slot}.options[${index}]`, `${value} ${label}`]));
    }
  }
  for (const [where, text] of texts) {
    if (typeof text === 'string' && NOT_ENGLISH.test(text)) errors.push(`${where}: text shown to workers must be in English (found ${JSON.stringify(text.slice(0, 40))}).`);
  }
}

/** 이미지와 영상 칸의 값이 주소처럼 보이는지 본다. 글이 src 에 들어가면 화면이 깨진다. */
function checkKinds({ slots, context, taskType, binding, reader, tabs, errors }) {
  const fields = [
    ...context.map((field, index) => ({ field, where: `context[${index}]`, fallback: 'text' })),
    ...DATA_SLOTS.flatMap((slot) => (slots[slot] ?? []).map((field, index) => ({ field, where: `slots.${slot}${slots[slot].length > 1 ? `[${index}]` : ''}`, fallback: defaultKind(taskType) }))),
  ];
  for (const { field, where, fallback } of fields) {
    if (field.kind !== undefined && !DATA_KINDS.includes(field.kind)) {
      errors.push(`${where}: "kind" must be ${DATA_KINDS.join(', ')}.`);
      continue;
    }
    if ((field.kind ?? fallback) === 'text') continue;
    const parsed = parsePath(field.from);
    const rows = Math.min(reader.rowCount, CHECK_ROWS);
    for (let rowIndex = 0; rowIndex < rows; rowIndex += 1) {
      const value = resolve(parsed, reader.cell(rowIndex, parsed.column), 0);
      if (typeof value === 'string' && value !== '' && !URL_LIKE.test(value.trim())) {
        errors.push(`${where}: "${field.from}" does not look like a URL, but this slot shows an ${field.kind ?? fallback}. Add "kind": "text" to show it as text, or choose another column.`);
        break;
      }
    }
  }
}

function checkReferenceShape(reference, errors) {
  const forms = ['value', 'map', 'selected'].filter((form) => reference[form] !== undefined);
  if (forms.length !== 1) {
    errors.push('"reference" must have exactly one of "value", "map" or "selected".');
    return null;
  }
  const form = forms[0];
  if (form !== 'value' && typeof reference.key !== 'string') errors.push(`reference: "${form}" needs "key".`);
  if (form === 'selected' && (typeof reference.item !== 'string' || typeof reference.yes !== 'string' || typeof reference.no !== 'string')) errors.push('reference: "selected" needs "item", "yes" and "no".');
  return form;
}

/** 대조 기준과 attention 기대 답이 문항의 선택지와 맞는지 앞쪽 HIT 로 본다. */
function checkJudged({ binding, design, slots, reader, tabs, errors, warnings }) {
  const slot = judgedSlot(design);
  const options = slot ? slots[slot].options.map(([value]) => value) : [];
  const expected = binding.attention?.expected;
  if (expected !== undefined) {
    if (binding.attention?.flag === undefined) errors.push('attention.expected needs attention.flag.');
    else if (!slot) errors.push(`attention.expected needs a question to check, but the ${design.title} design has none.`);
    else if (!options.includes(String(expected))) errors.push(`attention.expected: "${expected}" is not one of the options of "${slot}" (${options.join(', ')}).`);
  }
  const { reference } = binding;
  if (reference === undefined) return;
  if (!isObject(reference)) {
    errors.push('"reference" must be an object.');
    return;
  }
  if (!slot) {
    errors.push(`"reference" needs a question to compare with, but the ${design.title} design has none.`);
    return;
  }
  const form = checkReferenceShape(reference, errors);
  if (form === null) return;
  const parsed = parsePath(reference[form]);
  if (!parsed || !reader.columns.includes(parsed.column)) errors.push(`reference.${form}: ${JSON.stringify(reference[form])} is not a path to a column of the data.`);
  else if (!binding.repeat && parsed.steps.some((step) => step.index === 'i')) errors.push(`reference.${form}: [i] needs "repeat".`);
  if (errors.length > 0) return;
  const seen = new Set();
  let labelled = 0;
  let answers = 0;
  const rows = Math.min(reader.rowCount, CHECK_ROWS);
  for (let rowIndex = 0; rowIndex < rows; rowIndex += 1) {
    const labels = referenceLabels(binding, design, slots, tabs, reader, rowIndex);
    answers += labels.answerCount;
    for (const value of Object.values(labels.values)) {
      labelled += 1;
      seen.add(value);
    }
  }
  if (labelled === 0) {
    errors.push(`reference: no labels were found in the first ${rows} HIT(s). Check the path and the key.`);
    return;
  }
  const lower = options.map((option) => option.trim().toLowerCase());
  const outside = [...seen].filter((value) => !lower.includes(value.trim().toLowerCase()));
  if (outside.length > 0) errors.push(`reference: label(s) ${outside.slice(0, 5).map((v) => JSON.stringify(v)).join(', ')} are not options of "${slot}" (${options.join(', ')}). Use the labels of the data as option values.`);
  else if (labelled < answers) warnings.push(`The reference labels cover ${labelled} of ${answers} answers in the first ${rows} HIT(s). Review compares only the labelled ones.`);
}

/** HIT 하나의 대조 기준 { 답 이름: 라벨 }. attention 항목은 뺀다. */
function referenceLabels(binding, design, slots, tabs, reader, rowIndex) {
  const out = { values: {}, answerCount: 0 };
  const slot = judgedSlot(design);
  const { reference } = binding;
  if (!slot || !reference) return out;
  const spec = slots[slot];
  const flags = new Set(attentionItems(binding, tabs, reader, rowIndex));
  const form = ['value', 'map', 'selected'].find((name) => reference[name] !== undefined);
  const parsed = parsePath(reference[form]);
  const cell = reader.cell(rowIndex, parsed.column);
  for (const tabIndex of tabs > 0 ? Array.from({ length: tabs }, (_, index) => index) : [null]) {
    if (flags.has((tabIndex ?? 0) + 1)) continue;
    const root = resolve(parsed, cell, tabIndex ?? 0);
    const itemCount = slot === 'item-choice' ? itemsOf(spec, reader, rowIndex, tabIndex).length : 1;
    answerNames(slot, spec, tabIndex, itemCount).forEach((name, index) => {
      out.answerCount += 1;
      let label;
      if (form === 'value') label = slot === 'item-choice' ? asItems(root)[index] : root;
      else if (form === 'map') label = isObject(root) ? root[fillKey(reference.key, tabIndex, index + 1)] : undefined;
      else {
        const selected = isObject(root) ? asItems(root[fillKey(reference.key, tabIndex, index + 1)]) : [];
        label = selected.map(String).includes(fillKey(reference.item, tabIndex, index + 1)) ? reference.yes : reference.no;
      }
      if (typeof label === 'string' || typeof label === 'number' || typeof label === 'boolean') out.values[name] = String(label);
    });
  }
  return out;
}

/** HIT 하나의 attention 기대 답 { 답 이름: 기대 값 }. */
function attentionAnswers(binding, design, slots, tabs, reader, rowIndex) {
  const out = {};
  const slot = judgedSlot(design);
  const expected = binding.attention?.expected;
  if (!slot || expected === undefined) return out;
  const spec = slots[slot];
  for (const number of attentionItems(binding, tabs, reader, rowIndex)) {
    const tabIndex = tabs > 0 ? number - 1 : null;
    const itemCount = slot === 'item-choice' ? itemsOf(spec, reader, rowIndex, tabIndex).length : 1;
    for (const name of answerNames(slot, spec, tabIndex, itemCount)) out[name] = String(expected);
  }
  return out;
}

function itemsOf(spec, reader, rowIndex, tabIndex) {
  if (typeof spec.items !== 'string') return asItems(spec.items);
  const parsed = parsePath(spec.items);
  return asItems(resolve(parsed, reader.cell(rowIndex, parsed.column), tabIndex ?? 0));
}

/** 폼에 보일 칸의 값. 없는 문항 칸은 예시로 채운다. */
export function filledSlots(binding, design, taskType) {
  return normalize(binding, design, taskType).slots;
}

/** 대조 기준과 attention 이 가리키는 문항의 { slot, options }. 문항이 없는 가안이면 null. */
export function judgedOptions(binding, design, taskType) {
  const slot = judgedSlot(design);
  return slot ? { slot, options: normalize(binding, design, taskType).slots[slot].options } : null;
}

/** 게시 설정에 얹을 값: 대조 기준과 attention 의 컬럼. */
export function bindingSettings(binding) {
  const settings = {};
  if (binding.reference !== undefined) settings.referenceColumn = REFERENCE_COLUMN;
  if (binding.attention?.expected !== undefined) Object.assign(settings, { attentionEnabled: true, attentionMode: 'column', attentionColumn: ATTENTION_COLUMN, attentionMinRatio: 1 });
  return settings;
}

/** 미리보기에 알릴 수: 이 HIT 의 대조 기준과 attention 기대 답. */
export function judgedCounts(binding, design, taskType, tabs, reader, rowIndex) {
  const { slots } = normalize(binding, design, taskType);
  return { reference: Object.keys(referenceLabels(binding, design, slots, tabs, reader, rowIndex).values).length, attention: Object.keys(attentionAnswers(binding, design, slots, tabs, reader, rowIndex)).length };
}

// ---- 조립 ---------------------------------------------------------------------------------------

function slotColumn(slot, fieldIndex, fieldCount, tabIndex) {
  const base = `slot_${slot.replace(/-/g, '_')}`;
  return `${base}${fieldCount > 1 ? `_f${fieldIndex + 1}` : ''}${tabIndex === null ? '' : `_${tabIndex + 1}`}`;
}

/** 검사를 통과한 binding 의 템플릿. tabs 는 checkBinding 의 값이다. */
export function buildBoundTemplate(binding, design, taskType, tabs) {
  const { slots, context } = normalize(binding, design, taskType);
  const content = taskContent(taskType);
  const contextLines = (tabIndex) => context.flatMap((field, index) => dataLines(field.kind ?? 'text', slotColumn('context', index, context.length, tabIndex), field.label ?? 'Context'));
  const slotLines = (slot, tabIndex) => {
    const suffix = tabIndex === null ? '' : `_${tabIndex + 1}`;
    const spec = slots[slot];
    if (DATA_SLOTS.includes(slot)) {
      return spec.flatMap((field, index) => dataLines(field.kind ?? defaultKind(taskType), slotColumn(slot, index, spec.length, tabIndex), field.label ?? content.label));
    }
    if (slot === 'choice') return choiceLines({ name: `${spec.name}${suffix}`, header: spec.header, options: spec.options });
    if (slot === 'compare') return choiceLines({ name: `${spec.name}${suffix}`, header: spec.header, options: spec.options, horizontal: true });
    if (slot === 'item-choice') return itemChoiceLines({ name: `${spec.name}${suffix}`, header: spec.header, column: slotColumn(slot, 0, 1, tabIndex), options: spec.options });
    return freeTextLines({ name: `${spec.name}${suffix}`, header: spec.header, placeholder: spec.placeholder });
  };
  return assembleTemplate({
    design,
    instructions: binding.instructions ?? instructionsFor({ ...design, tabs: tabs > 0 }, taskType),
    tabs,
    tabLabel: binding.repeat?.label ?? fieldsOf(binding.slots?.data)[0]?.label ?? content.label,
    slotLines,
    contextLines,
  });
}

/** HIT 하나의 게시용 행: 칸마다 만든 컬럼 + binding 이 쓰지 않은 원래 컬럼. */
export function boundRow(binding, design, taskType, tabs, reader, rowIndex) {
  const { slots, context } = normalize(binding, design, taskType);
  const consumed = new Set(pathsOf(binding, slots, context).map(({ path }) => parsePath(path).column));
  const row = {};
  for (const column of reader.columns) {
    if (!consumed.has(column)) row[column] = reader.raw(rowIndex, column);
  }
  const tabIndexes = tabs > 0 ? Array.from({ length: tabs }, (_, index) => index) : [null];
  for (const tabIndex of tabIndexes) {
    const read = (path) => {
      const parsed = parsePath(path);
      return resolve(parsed, reader.cell(rowIndex, parsed.column), tabIndex);
    };
    const fill = (slot, fields, fallback) => {
      fields.forEach((field, index) => {
        const text = displayText(read(field.from));
        row[slotColumn(slot, index, fields.length, tabIndex)] = (field.kind ?? fallback) === 'text' ? escapeHtml(text) : text.replace(/"/g, '%22');
      });
    };
    fill('context', context, 'text');
    for (const [slot, spec] of Object.entries(slots)) {
      if (DATA_SLOTS.includes(slot)) fill(slot, spec, defaultKind(taskType));
      else if (slot === 'item-choice') row[slotColumn(slot, 0, 1, tabIndex)] = itemsCell(typeof spec.items === 'string' ? read(spec.items) : spec.items);
    }
  }
  if (binding.reference !== undefined) row[REFERENCE_COLUMN] = JSON.stringify(referenceLabels(binding, design, slots, tabs, reader, rowIndex).values);
  if (binding.attention?.expected !== undefined) row[ATTENTION_COLUMN] = JSON.stringify(attentionAnswers(binding, design, slots, tabs, reader, rowIndex));
  return row;
}

/** 모든 HIT 의 게시용 데이터 → Publish Batch 의 data 모양. */
export function boundData(binding, design, taskType, tabs, reader, fileName) {
  const rows = Array.from({ length: reader.rowCount }, (_, rowIndex) => boundRow(binding, design, taskType, tabs, reader, rowIndex));
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  return { fileName, columns, rows, hadBom: false, warnings: [] };
}

/** 이 HIT 에서 attention 표시가 있는 항목 번호(1부터). 미리보기의 안내에 쓴다. */
export function attentionItems(binding, tabs, reader, rowIndex) {
  const flag = binding.attention?.flag;
  if (flag === undefined) return [];
  const parsed = parsePath(flag);
  const isSet = (value) => value === true || value === 1 || value === '1';
  if (tabs === 0) return isSet(resolve(parsed, reader.cell(rowIndex, parsed.column), 0)) ? [1] : [];
  return Array.from({ length: tabs }, (_, index) => index).flatMap((index) => (isSet(resolve(parsed, reader.cell(rowIndex, parsed.column), index)) ? [index + 1] : []));
}

// ---- LLM 에 묻기 --------------------------------------------------------------------------------

const SAMPLE_CHARS = 280;
const SAMPLE_LIST_ITEMS = 3;
const SAMPLE_KEYS = 4;
const SHAPE_ROWS = 20;
const SUMMARY_KEYS = 16;

/** 값의 모양: str, int, list[11] of str, list[11] of list[str], object{a, b}. */
function shapeOf(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) {
    const inner = [...new Set(value.slice(0, 20).map(shapeOfElement))];
    return `list[${value.length}]${inner.length > 0 ? ` of ${inner.join(' | ')}` : ''}`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value);
    return `object{${keys.slice(0, SAMPLE_KEYS).join(', ')}${keys.length > SAMPLE_KEYS ? ', …' : ''}}`;
  }
  return typeof value === 'string' ? 'str' : typeof value === 'boolean' ? 'bool' : 'number';
}

function shapeOfElement(value) {
  return Array.isArray(value) ? `list[${[...new Set(value.slice(0, 20).map(shapeOfElement))].join(' | ')}]` : typeof value === 'object' && value !== null ? 'object' : shapeOf(value);
}

/** LLM 에 보여 줄 만큼 줄인 값. 긴 글은 자르고 목록은 앞의 몇 개만 둔다. */
function sampleOf(value) {
  if (typeof value === 'string') return value.length > SAMPLE_CHARS ? `${value.slice(0, SAMPLE_CHARS)}… (${value.length} characters)` : value;
  if (Array.isArray(value)) {
    const shown = value.slice(0, SAMPLE_LIST_ITEMS).map(sampleOf);
    return value.length > SAMPLE_LIST_ITEMS ? [...shown, `… ${value.length - SAMPLE_LIST_ITEMS} more`] : shown;
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value);
    const shown = Object.fromEntries(entries.slice(0, SAMPLE_KEYS).map(([key, item]) => [key, sampleOf(item)]));
    return entries.length > SAMPLE_KEYS ? { ...shown, '…': `${entries.length - SAMPLE_KEYS} more keys` } : shown;
  }
  return value;
}

/** HIT 데이터의 구조와 표본. 파일 전체 대신 이것만 서버와 LLM 으로 보낸다. */
export function summarizeData(reader) {
  const rowsForShape = Math.min(reader.rowCount, SHAPE_ROWS);
  const sampleRows = [...new Set([0, Math.floor(reader.rowCount / 2)])].filter((rowIndex) => rowIndex < reader.rowCount);
  return {
    hit_count: reader.rowCount,
    columns: reader.columns.map((name) => {
      const shapes = new Set();
      for (let rowIndex = 0; rowIndex < rowsForShape; rowIndex += 1) shapes.add(shapeOf(reader.cell(rowIndex, name)));
      // 표본은 앞쪽 몇 개뿐이므로, 목록의 값이 서로 다른지는 전체 HIT 에서 세어 알린다
      const distinct = Array.from({ length: reader.rowCount }, (_, rowIndex) => reader.cell(rowIndex, name)).filter(Array.isArray).map(distinctCount);
      // 객체(또는 객체 목록)의 키: 표본은 키 몇 개만 보이므로 경로 .key 로 읽을 수 있는 키를 따로 알린다
      const keyShapes = new Map();
      for (let rowIndex = 0; rowIndex < rowsForShape; rowIndex += 1) {
        const value = reader.cell(rowIndex, name);
        const objects = Array.isArray(value) ? value.filter(isObject) : isObject(value) ? [value] : [];
        for (const object of objects.slice(0, 20)) {
          for (const [key, item] of Object.entries(object)) {
            if (!keyShapes.has(key) && keyShapes.size < SUMMARY_KEYS) keyShapes.set(key, new Set());
            keyShapes.get(key)?.add(shapeOf(item));
          }
        }
      }
      const keys = [...keyShapes].map(([key, set]) => ({ name: key, shape: [...set].slice(0, 2).join(' or ') }));
      return { name, shape: [...shapes].slice(0, 3).join(' or '), ...(distinct.length > 0 ? { distinct_per_list: { min: Math.min(...distinct), max: Math.max(...distinct) } } : {}), ...(keys.length > 0 ? { keys } : {}), samples: sampleRows.map((rowIndex) => sampleOf(reader.cell(rowIndex, name))) };
    }),
  };
}

/** 가안 정의 중 LLM 이 쓸 부분. */
export function designForRequest(design) {
  return { id: design.id, title: design.title, summary: design.summary, rows: design.rows.map((row) => ({ ...(row.columns ? { columns: row.columns } : {}), slots: row.slots })), ...(design.tabs ? { one_tab_per_item: true } : {}), ...(design.open ? { open: true } : {}) };
}

/**
 * LLM 에 binding 을 묻고 검사한다. 오류가 있으면 오류와 이전 답을 보내 maxAttempts 번까지 다시 묻는다.
 * send(body) 는 POST /api/agent/bindings 이고, check(binding) 은 { errors } 를 돌려준다. request 에 current 가 있으면 수정 요청이다.
 * → { binding, message, cannot, errors, attempts, usage, model }. errors 가 남아 있으면 사람이 고치도록 마지막 답을 돌려준다.
 * 할 수 없는 요청이라는 답(cannot)은 다시 묻지 않고 binding 없이 돌려준다.
 */
export async function requestBinding({ send, check, request, maxAttempts = 3 }) {
  let previous = null;
  let errors = [];
  const usage = { calls: 0 };
  let last = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const reply = await send(errors.length > 0 ? { ...request, previous, errors } : request);
    last = reply;
    for (const [key, value] of Object.entries(reply.usage ?? {})) {
      if (typeof value === 'number') usage[key] = (usage[key] ?? 0) + value;
    }
    const common = { message: reply.message ?? null, attempts: attempt, usage, model: reply.model };
    if (reply.cannot) return { ...common, binding: null, cannot: reply.cannot, errors: [] };
    errors = check(reply.binding).errors;
    if (errors.length === 0) return { ...common, binding: reply.binding, cannot: null, errors };
    previous = reply.binding;
  }
  return { binding: last.binding, message: last.message ?? null, cannot: null, errors, attempts: maxAttempts, usage, model: last.model };
}

// ---- 가안 바꾸기와 첫 binding ---------------------------------------------------------------------

/**
 * 다른 가안으로 옮긴다. 데이터 값과 문항을 새 가안의 칸으로 옮기고, 새 칸에 없는 값은 unused 에 두어 돌아왔을 때 되살린다.
 * LLM 을 다시 부르지 않고 가안을 비교하기 위한 것이다.
 */
export function adaptBinding(binding, designId) {
  const staying = binding.design === designId;
  const savedLayout = binding.unused?.layout;
  let layout = staying ? binding.layout : savedLayout?.design === designId ? savedLayout.layout : undefined;
  // Others 로 넘어오면 지금 배치에서 출발한다. 임시 배치로 가면 문항 칸의 값이 사라져 보이기 때문이다
  if (layout === undefined && !staying && roughDesignById(designId).open) layout = { rows: designOf(binding).rows.map(({ columns, slots }) => ({ ...(columns ? { columns } : {}), slots })) };
  const target = layout !== undefined && layoutErrors(layout).length === 0 ? withLayout(roughDesignById(designId), layout) : roughDesignById(designId);
  const source = { ...binding.unused, ...binding.slots };
  const targetSlots = slotsOf(target);
  const fields = DATA_SLOTS.flatMap((slot) => fieldsOf(source[slot]));
  const slots = {};
  if (targetSlots.includes('data') && fields.length > 0) slots.data = fields.length === 1 ? fields[0] : fields;
  if (targetSlots.includes('data-a')) {
    if (fields[0]) slots['data-a'] = fields[0];
    if (fields[1]) slots['data-b'] = fields[1];
  }
  for (const slot of ANSWER_SLOTS) {
    if (targetSlots.includes(slot) && source[slot] !== undefined) slots[slot] = source[slot];
  }
  const unused = Object.fromEntries(Object.entries(source).filter(([slot]) => ANSWER_SLOTS.includes(slot) && !targetSlots.includes(slot)));
  const next = { ...binding, design: designId, slots };
  if (layout !== undefined) next.layout = layout;
  else delete next.layout;
  // 고친 배치는 그 가안의 것이다. 다른 가안으로 가면 보관했다가 돌아오면 되살린다
  if (!staying && binding.layout !== undefined) unused.layout = { design: binding.design, layout: binding.layout };
  else if (savedLayout && savedLayout.design !== designId) unused.layout = savedLayout;
  // 대조 기준과 기대 답은 문항 칸에 달렸다. 문항 칸이 달라지면 보관했다가 돌아오면 되살린다
  const sourceJudged = judgedSlot(designOf(binding));
  const targetJudged = judgedSlot(target);
  let checks = binding.unused?.judged ?? null;
  if (sourceJudged !== targetJudged && (binding.reference !== undefined || binding.attention?.expected !== undefined)) {
    checks = { slot: sourceJudged, reference: binding.reference, expected: binding.attention?.expected };
    delete next.reference;
    if (next.attention) {
      next.attention = { ...next.attention };
      delete next.attention.expected;
    }
  } else if (checks && checks.slot === targetJudged) {
    if (checks.reference !== undefined) next.reference = checks.reference;
    if (checks.expected !== undefined && next.attention) next.attention = { ...next.attention, expected: checks.expected };
    checks = null;
  }
  if (checks) unused.judged = checks;
  if (Object.keys(unused).length > 0) next.unused = unused;
  else delete next.unused;
  return next;
}

/** 고친 배치를 버리고 가안의 배치로 돌아간다. 가안에 없는 칸의 값은 unused 에 남는다. */
export function dropLayout(binding) {
  const { layout, ...rest } = binding;
  return adaptBinding(rest, binding.design);
}

/** 값의 글자 수로 보여 줄 만한 컬럼을 고른다. 이미지와 영상 칸이면 주소처럼 보이는 컬럼을 먼저 본다. 글이 src 에 들어가면 올리자마자 오류가 나기 때문이다. */
function pickDataColumns(reader, preferred, wantsUrl) {
  if (reader.columns.includes(preferred)) return [preferred];
  if (wantsUrl) {
    const first = (column) => {
      const value = reader.cell(0, column);
      return Array.isArray(value) ? value[0] : value;
    };
    const urls = reader.columns.filter((column) => typeof first(column) === 'string' && URL_LIKE.test(first(column).trim()));
    if (urls.length > 0) return urls;
  }
  const sampleRows = Math.min(reader.rowCount, 5);
  const score = (column) => {
    let total = 0;
    for (let rowIndex = 0; rowIndex < sampleRows; rowIndex += 1) total += displayText(reader.cell(rowIndex, column)).length;
    return total;
  };
  // 목록의 목록은 탭마다 판단할 항목일 때가 많으므로 글 목록과 글 컬럼을 먼저 본다
  const nested = (column) => {
    const value = reader.cell(0, column);
    return Array.isArray(value) && value.some((item) => typeof item === 'object' && item !== null) ? 1 : 0;
  };
  const candidates = reader.columns.filter((column) => !SKIP_COLUMN.test(column));
  return (candidates.length > 0 ? candidates : reader.columns).map((column) => [column, score(column), nested(column)]).sort((a, b) => a[2] - b[2] || b[1] - a[1]).map(([column]) => column);
}

/** 처음 보여 줄 binding. 사람이 고쳐 쓰는 출발점이며, 글이 가장 긴 컬럼을 데이터 칸에 넣는다. 문항 칸은 비워 예시를 쓴다. */
export function draftBinding(designId, taskTypeId, reader) {
  const design = roughDesignById(designId);
  const taskType = taskTypeById(taskTypeId);
  const content = taskContent(taskType);
  const columns = pickDataColumns(reader, content.column, defaultKind(taskType) !== 'text');
  const binding = { design: designId, task_type: taskTypeId, slots: {} };
  const repeat = Array.isArray(reader.cell(0, columns[0]));
  if (repeat) binding.repeat = { over: columns[0], label: content.label };
  const dataSlots = slotsOf(design).filter((slot) => DATA_SLOTS.includes(slot));
  dataSlots.forEach((slot, index) => {
    const column = repeat ? columns[0] : columns[index] ?? columns[0];
    binding.slots[slot] = { label: dataSlots.length > 1 ? `${content.label} ${index + 1}` : content.label, from: repeat ? `${column}[i]` : column };
  });
  return binding;
}

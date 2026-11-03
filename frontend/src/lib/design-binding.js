// 이미 HIT 로 묶인 데이터를 rough design 의 칸에 넣는다. binding 은 "어떤 값이 어느 칸에 들어갈지"만 적은 JSON 이고,
// 값 꺼내기와 템플릿 조립은 코드가 맡는다. 지금은 사람이 binding 을 쓰고, 다음 단계에서 LLM 이 같은 형식을 쓴다.
//   {
//     "design": "item-list", "task_type": "text",
//     "repeat": { "over": "retrieved_chunk", "label": "Chunk" },      HIT 안의 항목마다 탭 하나. 없으면 HIT 당 화면 하나다
//     "slots": {
//       "data": { "label": "Chunk", "from": "retrieved_chunk[i]" },   데이터 칸. 여러 값을 보이려면 배열로 쓴다
//       "checklist": { "header": "…", "items": "atomic_facts[i]" },    항목은 경로 또는 글 목록
//       "choice": { "header": "…", "options": [["yes", "Yes"], "no"] },
//       "compare": { "header": "…" }, "free-text": { "header": "…", "placeholder": "…" }
//     },
//     "attention": { "flag": "attention_check[i]" },                  미리보기에서 attention 항목을 알리는 데만 쓴다
//     "instructions": "…"                                             없으면 task 종류의 예시 안내문
//   }
// 경로는 컬럼 이름 뒤에 [i](repeat 의 현재 항목), [숫자], .키 를 붙인다. 셀은 JSON 이나 Python 리터럴이어도 구조로 읽는다.
// 게시용 데이터는 칸마다 컬럼(slot_data_1 …)을 새로 만들고, binding 이 쓰지 않은 컬럼은 그대로 둔다.
// binding 에 없는 문항 칸은 예시 문항을 쓰고 경고한다. 가안을 바꾸면 adaptBinding 이 값을 새 칸으로 옮긴다.
// LLM 에게는 summarizeData 의 요약만 보내고, requestBinding 이 답을 checkBinding 으로 검사해 오류를 붙여 다시 묻는다.

import { assembleTemplate, checklistLines, choiceLines, compareOptions, dataLines, freeTextLines, instructionsFor, roughDesignById, taskContent, taskTypeById } from './rough-designs.js';

const DATA_SLOTS = ['data', 'data-a', 'data-b'];
const ANSWER_SLOTS = ['choice', 'compare', 'checklist', 'free-text'];
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PATH = /^([^\s[\].]+)((?:\[(?:i|\d+)\]|\.[^\s[\].]+)*)$/;
const STEP = /\[(i|\d+)\]|\.([^\s[\].]+)/g;
const SKIP_COLUMN = /(^|_)(q?id|idx|ids|index|counts?|check|reasoning|reason|label|gold|expected)$/i;

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
  return design.rows.flatMap((row) => row.slots);
}

function optionPairs(options) {
  return (options ?? []).map((option) => (Array.isArray(option) ? [String(option[0]), String(option[1] ?? option[0])] : [String(option), String(option)]));
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
    } else if (slot === 'checklist') {
      slots[slot] = { name: spec?.name ?? content.checklist.name, header: spec?.header ?? content.checklist.header, items: spec?.items ?? content.checklist.items };
    } else {
      slots[slot] = { name: spec?.name ?? content.freeText.name, header: spec?.header ?? content.freeText.header, placeholder: spec?.placeholder ?? content.freeText.placeholder };
    }
  }
  return { slots, sampled };
}

/** binding 이 경로로 읽는 모든 곳 [{ where, path }]. */
function pathsOf(binding, slots) {
  const paths = [];
  if (binding.repeat) paths.push({ where: 'repeat.over', path: binding.repeat.over });
  for (const [slot, spec] of Object.entries(slots)) {
    if (DATA_SLOTS.includes(slot)) spec.forEach((field, index) => paths.push({ where: `slots.${slot}${spec.length > 1 ? `[${index}]` : ''}.from`, path: field?.from }));
    else if (slot === 'checklist' && typeof spec.items === 'string') paths.push({ where: 'slots.checklist.items', path: spec.items });
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

  const designSlots = slotsOf(design);
  for (const slot of Object.keys(binding.slots ?? {})) {
    if (!designSlots.includes(slot)) errors.push(`The ${design.title} design has no slot "${slot}". Its slots are ${designSlots.join(', ')}.`);
  }
  if (design.tabs && !binding.repeat) errors.push(`The ${design.title} design shows one item per tab, so it needs "repeat" over a list column.`);
  const { slots, sampled } = normalize(binding, design, taskType);
  for (const slot of designSlots.filter((name) => DATA_SLOTS.includes(name))) {
    if (slots[slot].length === 0) errors.push(`Slot "${slot}" has no data. Add {"from": "<column>"} to it.`);
  }
  for (const slot of ANSWER_SLOTS.filter((name) => designSlots.includes(name))) {
    const { name, options, items } = slots[slot];
    if (!NAME.test(String(name))) errors.push(`Slot "${slot}": "name" must use letters, digits and _, starting with a letter or _.`);
    if (options && options.length < 2) errors.push(`Slot "${slot}" needs at least two options.`);
    if (slot === 'checklist' && typeof items !== 'string' && !Array.isArray(items)) errors.push('Slot "checklist": "items" must be a path or a list.');
  }
  for (const { where, path } of pathsOf(binding, slots)) {
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
    else if (Math.min(...counts) !== result.tabs) warnings.push(`HITs have different numbers of items (${Math.min(...counts)} to ${result.tabs}). Shorter HITs show empty tabs.`);
  }
  for (const slot of sampled) warnings.push(`Slot "${slot}" has no binding, so the example question is shown. Replace it before you publish.`);
  return result;
}

// ---- 조립 ---------------------------------------------------------------------------------------

function slotColumn(slot, fieldIndex, fieldCount, tabIndex) {
  const base = `slot_${slot.replace(/-/g, '_')}`;
  return `${base}${fieldCount > 1 ? `_f${fieldIndex + 1}` : ''}${tabIndex === null ? '' : `_${tabIndex + 1}`}`;
}

/** 검사를 통과한 binding 의 템플릿. tabs 는 checkBinding 의 값이다. */
export function buildBoundTemplate(binding, design, taskType, tabs) {
  const { slots } = normalize(binding, design, taskType);
  const content = taskContent(taskType);
  const slotLines = (slot, tabIndex) => {
    const suffix = tabIndex === null ? '' : `_${tabIndex + 1}`;
    const spec = slots[slot];
    if (DATA_SLOTS.includes(slot)) {
      return spec.flatMap((field, index) => dataLines(taskType, slotColumn(slot, index, spec.length, tabIndex), field.label ?? content.label));
    }
    if (slot === 'choice') return choiceLines({ name: `${spec.name}${suffix}`, header: spec.header, options: spec.options });
    if (slot === 'compare') return choiceLines({ name: `${spec.name}${suffix}`, header: spec.header, options: spec.options, horizontal: true });
    if (slot === 'checklist') return checklistLines({ name: `${spec.name}${suffix}`, header: spec.header, column: slotColumn(slot, 0, 1, tabIndex) });
    return freeTextLines({ name: `${spec.name}${suffix}`, header: spec.header, placeholder: spec.placeholder });
  };
  return assembleTemplate({
    design,
    instructions: binding.instructions ?? instructionsFor({ ...design, tabs: tabs > 0 }, taskType),
    tabs,
    tabLabel: binding.repeat?.label ?? fieldsOf(binding.slots?.data)[0]?.label ?? content.label,
    slotLines,
  });
}

/** HIT 하나의 게시용 행: 칸마다 만든 컬럼 + binding 이 쓰지 않은 원래 컬럼. */
export function boundRow(binding, design, taskType, tabs, reader, rowIndex) {
  const { slots } = normalize(binding, design, taskType);
  const consumed = new Set(pathsOf(binding, slots).map(({ path }) => parsePath(path).column));
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
    for (const [slot, spec] of Object.entries(slots)) {
      if (DATA_SLOTS.includes(slot)) {
        spec.forEach((field, index) => {
          const text = displayText(read(field.from));
          row[slotColumn(slot, index, spec.length, tabIndex)] = taskType.id === 'text' ? escapeHtml(text) : text.replace(/"/g, '%22');
        });
      } else if (slot === 'checklist') {
        row[slotColumn(slot, 0, 1, tabIndex)] = itemsCell(typeof spec.items === 'string' ? read(spec.items) : spec.items);
      }
    }
  }
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
      return { name, shape: [...shapes].slice(0, 3).join(' or '), samples: sampleRows.map((rowIndex) => sampleOf(reader.cell(rowIndex, name))) };
    }),
  };
}

/** 가안 정의 중 LLM 이 쓸 부분. */
export function designForRequest(design) {
  return { id: design.id, title: design.title, summary: design.summary, rows: design.rows.map((row) => ({ slots: row.slots })), ...(design.tabs ? { one_tab_per_item: true } : {}) };
}

/**
 * LLM 에 binding 을 묻고 검사한다. 오류가 있으면 오류와 이전 답을 보내 maxAttempts 번까지 다시 묻는다.
 * send(body) 는 POST /api/agent/bindings 이고, check(binding) 은 { errors } 를 돌려준다.
 * → { binding, errors, attempts, usage, model }. errors 가 남아 있으면 사람이 고치도록 마지막 답을 돌려준다.
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
    errors = check(reply.binding).errors;
    if (errors.length === 0) return { binding: reply.binding, errors, attempts: attempt, usage, model: reply.model };
    previous = reply.binding;
  }
  return { binding: last.binding, errors, attempts: maxAttempts, usage, model: last.model };
}

// ---- 가안 바꾸기와 첫 binding ---------------------------------------------------------------------

/**
 * 다른 가안으로 옮긴다. 데이터 값과 문항을 새 가안의 칸으로 옮기고, 새 칸에 없는 값은 unused 에 두어 돌아왔을 때 되살린다.
 * LLM 을 다시 부르지 않고 가안을 비교하기 위한 것이다.
 */
export function adaptBinding(binding, designId) {
  const target = roughDesignById(designId);
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
  if (Object.keys(unused).length > 0) next.unused = unused;
  else delete next.unused;
  return next;
}

/** 값의 글자 수로 보여 줄 만한 컬럼을 고른다. */
function pickDataColumns(reader, preferred) {
  if (reader.columns.includes(preferred)) return [preferred];
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
  const columns = pickDataColumns(reader, content.column);
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

// annotation 단위(unit). 데이터를 올리면 Agent 가 과제의 단위를 정한다: 글은 document / chunk / sentence, 이미지는 image,
// 영상은 video(전체) / frame. 정하는 것은 Agent 이고, 기록을 HIT 로 바꾸는 일은 이 코드가 한다 (LLM 은 계획만 쓴다).
//
// 계약(task-contract.js)의 키:
//   "unit":   { "level": "sentence", "why": "…",
//               "group_by": "<컬럼>",                              같은 값의 기록을 HIT 하나로. 기록마다 다른 컬럼은 목록이 된다
//               "split": { "from": "<경로>", "by": "sentence" | "paragraph" } }   글을 나눠 새 목록 컬럼 <경로>_sentences / _paragraphs 를 만든다
//   "repeat": { "over": "<목록 컬럼>", "label": "Sentence", "per_hit": 8 }       per_hit: 단위가 많으면 HIT 를 여러 개로 자른다
//
//   unitOptions(reader)           → Agent 에게 보낼 단위 후보 (나눌 글, 묶을 컬럼, frame 목록, 이미지·영상 컬럼)
//   planData(data, contract)      → { data, errors, warnings }: 원본 표를 HIT 표로. 검사(task-contract.js)는 이 표로 한다
//   checkDesign(contract, data)   → { errors, warnings, tabs, data, reader }: planData + checkContract
//   unitSummary(contract, source, planned) → 화면에 보일 단위 요약

import { URL_LIKE, dataReader, parseCell, parsePath, resolvePath } from './design-binding.js';
import { checkContract, timeSeconds } from './task-contract.js';

export { timeSeconds };

export const UNIT_LEVELS = { text: ['document', 'chunk', 'sentence'], image: ['image'], video: ['video', 'frame'] };
export const ALL_LEVELS = [...new Set(Object.values(UNIT_LEVELS).flat())];
export const SPLIT_KINDS = ['sentence', 'paragraph'];
export const PART_COLUMN = 'unit_part';
export const START_COLUMN = 'unit_start';
const OPTION_ROWS = 200; // 후보를 셀 기록 수 (큰 파일에서도 빨리)
const OPTION_LIMIT = 4;
const ANSWER_LIKE = /(^|_)(gold|labels?|answers?|expected|truth|correct|check|attention)$/i;

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const cellText = (value) => (value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value));
const range = (counts) => (counts.length === 0 ? null : { min: Math.min(...counts), max: Math.max(...counts) });

// ---- 글 나누기 ------------------------------------------------------------------------------------

let segmenter;
function sentenceSegmenter() {
  if (segmenter === undefined) {
    try {
      segmenter = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'sentence' }) : null;
    } catch {
      segmenter = null;
    }
  }
  return segmenter;
}

/** 글 → 문장 목록. 줄바꿈도 문장의 끝으로 본다 (제목, 목록). */
export function splitSentences(text) {
  const out = [];
  for (const line of String(text ?? '').split(/\n+/)) {
    const tool = sentenceSegmenter();
    const parts = tool ? Array.from(tool.segment(line), (part) => part.segment) : line.split(/(?<=[.!?。！？])\s+/);
    for (const part of parts) if (part.trim() !== '') out.push(part.trim());
  }
  return out;
}

/** 글 → 문단 목록. 빈 줄로 나누고, 빈 줄이 없으면 줄바꿈으로 나눈다. */
export function splitParagraphs(text) {
  const source = String(text ?? '').replace(/\r\n/g, '\n');
  const blocks = source.split(/\n\s*\n/);
  const parts = blocks.length > 1 ? blocks : source.split('\n');
  return parts.map((part) => part.trim()).filter((part) => part !== '');
}

export function splitText(value, by) {
  const split = by === 'paragraph' ? splitParagraphs : splitSentences;
  // 묶은 뒤라 글이 목록이면 하나씩 나눠 잇는다
  if (Array.isArray(value)) return value.flatMap((item) => split(cellText(item)));
  return split(cellText(value));
}

/** 나눈 목록이 들어갈 컬럼 이름: text → text_sentences, meta.body → meta_body_paragraphs. */
export function splitColumn(from, by) {
  return `${String(from).replace(/\[(\d+)\]/g, '_$1').replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '')}_${by}s`;
}

// ---- Agent 에게 보낼 단위 후보 -----------------------------------------------------------------------

/**
 * 데이터에서 가능한 단위의 후보. Agent 는 이 안에서 고르고, 고른 것을 unit·repeat 로 적는다.
 * → { records, counted, split: [...], group_by: [...], lists: [...], frames: [...], media: { image, video } }
 */
export function unitOptions(reader) {
  const rows = Math.min(reader.rowCount, OPTION_ROWS);
  const cells = (column) => Array.from({ length: rows }, (_, rowIndex) => reader.cell(rowIndex, column));
  const split = [];
  const groupBy = [];
  const lists = [];
  const frames = [];
  const media = { image: [], video: [] };

  for (const column of reader.columns) {
    const values = cells(column);
    const texts = values.filter((value) => typeof value === 'string' && value.trim() !== '');
    const urls = texts.filter((value) => URL_LIKE.test(value.trim()));
    if (texts.length > 0 && urls.length === texts.length) {
      const video = urls.filter((value) => /\.(mp4|webm|mov|m4v|ogv)([?#]|$)/i.test(value)).length;
      media[video > urls.length / 2 ? 'video' : 'image'].push(column);
      continue;
    }
    // 나눌 수 있는 글: 문장이 둘 이상인 기록이 있는 컬럼
    if (texts.length > 0 && !ANSWER_LIKE.test(column)) {
      const sentences = texts.map((text) => splitSentences(text).length);
      if (Math.max(...sentences) >= 2) {
        const paragraphs = texts.map((text) => splitParagraphs(text).length);
        const length = Math.round(texts.reduce((sum, text) => sum + text.length, 0) / texts.length);
        split.push({ from: column, average_characters: length, sentence: { per_record: range(sentences), makes: splitColumn(column, 'sentence') }, paragraph: { per_record: range(paragraphs), makes: splitColumn(column, 'paragraph') } });
      }
    }
    // 묶을 수 있는 컬럼: 짧은 단순 값이 여러 기록에서 되풀이된다
    const scalars = values.map((value) => (isObject(value) || Array.isArray(value) ? null : cellText(value)));
    if (scalars.every((value) => value !== null && value !== '') && !ANSWER_LIKE.test(column) && Math.max(...scalars.map((value) => value.length)) <= 80) {
      const sizes = new Map();
      for (const value of scalars) sizes.set(value, (sizes.get(value) ?? 0) + 1);
      if (sizes.size >= 1 && sizes.size < rows) groupBy.push({ column, groups: sizes.size, records_per_group: range([...sizes.values()]) });
    }
    // 목록: 길이, 그리고 frame 이 될 수 있는 목록(시각, 이미지 주소)
    const arrays = values.filter(Array.isArray);
    if (arrays.length === values.length && arrays.length > 0) {
      lists.push({ column, length: range(arrays.map((list) => list.length)) });
      const flat = arrays.flat().filter((item) => item !== null && item !== '');
      if (flat.length > 0 && flat.every((item) => timeSeconds(item) !== null)) frames.push({ column, holds: 'times' });
      else if (flat.length > 0 && flat.every((item) => typeof item === 'string' && URL_LIKE.test(item.trim()))) frames.push({ column, holds: 'image addresses' });
    }
  }

  // 묶었을 때 하나로 남는 컬럼과 목록이 되는 컬럼. 같은 묶음을 만드는 컬럼(doc_id 와 doc_title)은 앞의 것 하나만 둔다
  const partitions = new Set();
  const grouped = groupBy
    .sort((a, b) => a.groups - b.groups)
    .filter((option) => {
      const seen = new Map();
      const signature = cells(option.column).map((value) => {
        const key = cellText(value);
        if (!seen.has(key)) seen.set(key, seen.size);
        return seen.get(key);
      }).join(',');
      if (partitions.has(signature)) return false;
      partitions.add(signature);
      return true;
    })
    .slice(0, OPTION_LIMIT)
    .map((option) => {
      const plan = groupColumns(reader.columns.map((column) => cells(column).map(cellText)), reader.columns, cells(option.column).map(cellText));
      return { ...option, stays_single: plan.single, becomes_list: plan.listed };
    });
  return {
    records: reader.rowCount,
    counted: rows,
    split: split.sort((a, b) => b.average_characters - a.average_characters).slice(0, OPTION_LIMIT),
    group_by: grouped,
    lists: lists.slice(0, 8),
    // 숫자 목록은 영상이 있을 때만 장면의 시각으로 본다
    frames: frames.filter((frame) => frame.holds !== 'times' || media.video.length > 0),
    media,
  };
}

/** 묶었을 때 모든 묶음에서 값이 같은 컬럼(하나로 남음)과 아닌 컬럼(목록). texts[c][r] 은 컬럼 c, 기록 r 의 글. */
function groupColumns(texts, columns, keys) {
  const firstOf = new Map();
  const single = [];
  const listed = [];
  columns.forEach((column, c) => {
    firstOf.clear();
    let same = true;
    for (let r = 0; r < keys.length && same; r += 1) {
      if (!firstOf.has(keys[r])) firstOf.set(keys[r], texts[c][r]);
      else if (firstOf.get(keys[r]) !== texts[c][r]) same = false;
    }
    (same ? single : listed).push(column);
  });
  return { single, listed };
}

// ---- 원본 표 → HIT 표 -----------------------------------------------------------------------------

function groupRows(data, column) {
  const keys = data.rows.map((row) => row[column] ?? '');
  const plan = groupColumns(data.columns.map((name) => data.rows.map((row) => row[name] ?? '')), data.columns, keys);
  const single = new Set(plan.single);
  const order = [];
  const members = new Map();
  data.rows.forEach((row, index) => {
    const key = keys[index];
    if (!members.has(key)) {
      members.set(key, []);
      order.push(key);
    }
    members.get(key).push(row);
  });
  const rows = order.map((key) => {
    const group = members.get(key);
    return Object.fromEntries(data.columns.map((name) => [name, single.has(name) ? group[0][name] ?? '' : JSON.stringify(group.map((row) => parseCell(row[name] ?? '')))]));
  });
  return { rows, single: plan.single, listed: plan.listed };
}

function splitRows(data, from, by) {
  const parsed = parsePath(from);
  const column = splitColumn(from, by);
  const rows = data.rows.map((row) => ({ ...row, [column]: JSON.stringify(splitText(resolvePath(parsed, parseCell(row[parsed.column] ?? ''), 0), by)) }));
  return { rows, columns: data.columns.includes(column) ? data.columns : [...data.columns, column], column };
}

/** 단위 목록이 per_hit 보다 길면 HIT 를 여러 개로 자른다. 단위 목록과 길이가 같은 목록 컬럼은 함께 자르고, 나머지는 복사한다. */
function cutRows(data, over, perHit) {
  const rows = [];
  let cut = 0;
  for (const row of data.rows) {
    const units = parseCell(row[over] ?? '');
    const count = Array.isArray(units) ? units.length : 0;
    const parts = Math.max(1, Math.ceil(count / perHit));
    if (parts > 1) cut += 1;
    if (parts === 1) {
      rows.push({ ...row, [PART_COLUMN]: '1', [START_COLUMN]: '1' });
      continue;
    }
    const lists = Object.fromEntries(data.columns.map((name) => [name, parseCell(row[name] ?? '')]).filter(([, value]) => Array.isArray(value) && value.length === count));
    for (let part = 0; part < parts; part += 1) {
      const next = { ...row, [PART_COLUMN]: String(part + 1), [START_COLUMN]: String(part * perHit + 1) };
      for (const [name, list] of Object.entries(lists)) next[name] = JSON.stringify(list.slice(part * perHit, (part + 1) * perHit));
      rows.push(next);
    }
  }
  const columns = [...data.columns.filter((name) => name !== PART_COLUMN && name !== START_COLUMN), PART_COLUMN, START_COLUMN];
  return { rows, columns, cut };
}

/**
 * 계약의 unit 과 repeat.per_hit 대로 원본 표를 HIT 표로 바꾼다. 순서는 묶기 → 나누기 → 자르기다.
 * → { data: { …data, columns, rows }, errors, warnings }. 오류가 있으면 data 는 null 이다.
 */
export function planData(data, contract) {
  const errors = [];
  const warnings = [];
  const unit = contract?.unit;
  let current = { ...data };
  if (unit !== undefined) {
    if (!isObject(unit)) return { data: null, errors: ['"unit" must be an object like {"level": "sentence", "why": "…"}.'], warnings };
    if (!ALL_LEVELS.includes(unit.level)) errors.push(`unit.level must be one of ${ALL_LEVELS.join(', ')}.`);
    if (unit.group_by !== undefined) {
      if (!data.columns.includes(unit.group_by)) errors.push(`unit.group_by: the data has no column "${unit.group_by}".`);
      else {
        const grouped = groupRows(current, unit.group_by);
        current = { ...current, rows: grouped.rows };
        if (grouped.rows.length === data.rows.length) warnings.push(`unit.group_by: every record has its own "${unit.group_by}", so nothing was grouped.`);
      }
    }
    if (unit.split !== undefined) {
      const { from, by } = isObject(unit.split) ? unit.split : {};
      const parsed = parsePath(from);
      if (!isObject(unit.split)) errors.push('unit.split must be {"from": "<text column>", "by": "sentence" | "paragraph"}.');
      else if (!SPLIT_KINDS.includes(by)) errors.push(`unit.split.by must be ${SPLIT_KINDS.join(' or ')}.`);
      else if (!parsed || parsed.steps.some((step) => step.index === 'i')) errors.push(`unit.split.from: ${JSON.stringify(from)} must be a column name, optionally followed by .key.`);
      else if (!current.columns.includes(parsed.column)) errors.push(`unit.split.from: the data has no column "${parsed.column}".`);
      else {
        const result = splitRows(current, from, by);
        current = { ...current, rows: result.rows, columns: result.columns };
        const empty = result.rows.filter((row) => row[result.column] === '[]').length;
        if (empty > 0) warnings.push(`unit.split: "${from}" has no text in ${empty} record(s), so they have no ${by}s.`);
      }
    }
  }
  const perHit = contract?.repeat?.per_hit;
  if (perHit !== undefined && errors.length === 0) {
    const over = contract.repeat.over;
    if (!Number.isInteger(perHit) || perHit < 1) errors.push('repeat.per_hit must be a whole number of at least 1.');
    else if (typeof over !== 'string' || !current.columns.includes(over)) errors.push(`repeat.per_hit needs "repeat.over" to be a list column of the data (not a path)${typeof over === 'string' ? `; "${over}" is not one` : ''}.`);
    else if (['map', 'selected'].some((form) => (Array.isArray(contract.reference) ? contract.reference : [contract.reference]).some((ref) => isObject(ref) && ref[form] !== undefined))) {
      errors.push('repeat.per_hit cannot be used with a "map" or "selected" reference: their keys count items from the first one of the record.');
    } else {
      const result = cutRows(current, over, perHit);
      current = { ...current, rows: result.rows, columns: result.columns };
      if (result.cut > 0) warnings.push(`${result.cut} record(s) had more than ${perHit} ${contract.repeat.label ? `${String(contract.repeat.label).toLowerCase()}s` : 'items'} and were cut into several HITs (see "${PART_COLUMN}" and "${START_COLUMN}").`);
    }
  }
  return errors.length > 0 ? { data: null, errors, warnings } : { data: current, errors, warnings };
}

/**
 * planData + checkContract. 오류 문구는 그대로 Agent 에게 다시 보낸다. reader 는 HIT 표를 읽는다.
 * requireUnit: Draft with AI 의 Agent 답에는 unit 이 있어야 한다 (손으로 붙인 계약은 없어도 된다).
 */
export function checkDesign(contract, data, { requireUnit = false } = {}) {
  if (requireUnit && isObject(contract) && contract.unit === undefined) {
    return { errors: ['"unit" is missing. Decide the annotation unit: {"level": "document" | "chunk" | "sentence" | "image" | "video" | "frame", "why": "…"}.'], warnings: [], tabs: 0, data: null, reader: null };
  }
  const plan = planData(data, contract);
  if (!plan.data) return { errors: plan.errors, warnings: plan.warnings, tabs: 0, data: null, reader: null };
  const reader = dataReader(plan.data);
  const check = checkContract(contract, reader);
  const errors = [...check.errors];
  const warnings = [...plan.warnings, ...check.warnings];
  const level = contract?.unit?.level;
  const kinds = new Set((Array.isArray(contract?.fields) ? contract.fields : []).map((field) => field?.kind ?? 'text'));
  if (['video', 'frame'].includes(level) && !kinds.has('video') && !kinds.has('image')) errors.push(`unit.level "${level}" needs a value shown as a video or an image.`);
  if (level === 'image' && !kinds.has('image')) errors.push('unit.level "image" needs a value shown as an image.');
  if (['sentence', 'chunk', 'frame'].includes(level) && !contract.repeat && reader.rowCount > 0) {
    warnings.push(`The unit is a ${level}, and each HIT shows one; make sure each record is one ${level}.`);
  }
  return { errors: [...new Set(errors)], warnings, tabs: check.tabs, data: plan.data, reader };
}

/** 화면의 단위 요약 → { level, why, how: [글], records, hits, perHit }. */
export function unitSummary(contract, source, planned) {
  const unit = isObject(contract?.unit) ? contract.unit : {};
  const how = [];
  if (unit.group_by) how.push(`records with the same ${unit.group_by} become one HIT`);
  if (isObject(unit.split)) how.push(`${unit.split.from} is split into ${unit.split.by}s`);
  if (contract?.repeat?.over) how.push(`one ${String(contract.repeat.label ?? 'item').toLowerCase()} per element of ${contract.repeat.over}`);
  if (contract?.repeat?.per_hit) how.push(`at most ${contract.repeat.per_hit} per HIT`);
  return { level: unit.level ?? null, why: typeof unit.why === 'string' ? unit.why : '', how, records: source?.rows?.length ?? 0, hits: planned?.rows?.length ?? 0 };
}

/** 다른 단위로 바꿔 달라는 요청 문장. 화면의 단위 버튼이 대화로 보낸다. */
export function unitRequest(level) {
  return `Change the unit to ${level}.`;
}

/** 이 데이터로 고를 수 있는 단위들 (화면의 버튼). 이미지·영상이 있으면 그 단위만, 없으면 글의 단위다. 지금 단위는 뺀다. */
export function unitChoices(options, contract) {
  const levels = [];
  if (options.media.video.length > 0) levels.push('video', ...(options.frames.length > 0 ? ['frame'] : []));
  if (options.media.image.length > 0) levels.push('image');
  if (levels.length === 0) levels.push('document', 'chunk', 'sentence');
  return levels.filter((level) => level !== contract?.unit?.level);
}

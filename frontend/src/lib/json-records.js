// Draft with AI 가 받는 데이터 읽기. Publish Batch 의 json-data.js 는 "객체 하나가 HIT 하나인 배열"만 받지만, 여기서는 어느 정도
// 정리된 JSON 이면 모양에 상관없이 기록(record) 목록을 찾아 같은 표 { columns, rows } 로 만든다. 기록을 HIT 로 묶거나 나누는 일은
// 그 뒤 lib/task-unit.js 가 Agent 가 정한 단위대로 한다.
//
//   [{…}, {…}]                         기록 목록 그대로
//   ["text", "text"]                   값 하나짜리 기록 {"value": …}
//   {"data": {"items": [{…}]}}         가장 긴 객체 목록(깊이 3까지)을 기록으로. 그 위의 단순 값(제목, 버전)은 기록마다 복사한다
//   {"a1": {…}, "a2": {…}}             id 로 묶인 객체들(하나여도). 키는 "key" 컬럼이 된다
//   {"title": "…", "text": "…"}        기록 하나
//   JSON Lines (.jsonl)                줄마다 기록 하나
//
// → { fileName, columns, rows, hadBom, warnings, source: { kind, path, records } }. 행의 값은 모두 문자열이다 (json-data.js 와 같음).

import { DataFileError } from './json-data.js';

const BOM = '﻿';
const SEARCH_DEPTH = 3;
const LISTED = 5;

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isScalar = (value) => value === null || ['string', 'number', 'boolean'].includes(typeof value);

function cellText(value) {
  if (value === null || value === undefined) return '';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

/** 줄마다 JSON 값 하나인 글. 빈 줄은 건너뛴다. 한 줄이라도 JSON 이 아니면 null. */
function parseLines(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (lines.length < 2) return null;
  try {
    return lines.map((line) => JSON.parse(line));
  } catch {
    return null;
  }
}

/** 객체 안에서 객체 목록을 찾는다 → [{ path, list, carried }]. carried 는 목록까지 가는 길에 있는 단순 값들이다. */
function objectLists(value, path = [], carried = {}, depth = 0, found = []) {
  if (depth > SEARCH_DEPTH || !isObject(value)) return found;
  const scalars = Object.fromEntries(Object.entries(value).filter(([, item]) => isScalar(item)));
  const nextCarried = { ...carried, ...scalars };
  for (const [key, item] of Object.entries(value)) {
    if (Array.isArray(item) && item.length > 0 && item.every(isObject)) found.push({ path: [...path, key], list: item, carried: nextCarried });
    else if (isObject(item)) objectLists(item, [...path, key], nextCarried, depth + 1, found);
  }
  return found;
}

/** JSON 값 → { records, kind, path, warnings }. 기록을 찾을 수 없으면 DataFileError. */
export function findRecords(value) {
  if (Array.isArray(value)) {
    if (value.length === 0) throw new DataFileError('The JSON array is empty. Add at least one record.');
    if (value.every(isObject)) return { records: value, kind: 'list', path: '', warnings: [] };
    const wrapped = value.filter((item) => !isObject(item)).length;
    const records = value.map((item) => (isObject(item) ? item : { value: item }));
    const warnings = wrapped < value.length ? [`${wrapped} item(s) were not objects; each became a record with one "value".`] : [];
    return { records, kind: wrapped === value.length ? 'values' : 'list', path: '', warnings };
  }
  if (!isObject(value)) throw new DataFileError('The file holds a single value. Upload a JSON object or a list of records.');
  if (Object.keys(value).length === 0) throw new DataFileError('The JSON object is empty.');

  const lists = objectLists(value);
  if (lists.length > 0) {
    // 가장 긴 목록, 길이가 같으면 얕은 것. 길 위의 단순 값은 기록에 없는 이름일 때만 복사한다
    const best = [...lists].sort((a, b) => b.list.length - a.list.length || a.path.length - b.path.length)[0];
    const carriedKeys = Object.keys(best.carried);
    const records = best.list.map((record) => ({ ...Object.fromEntries(carriedKeys.filter((key) => !(key in record)).map((key) => [key, best.carried[key]])), ...record }));
    const path = best.path.join('.');
    const others = lists.filter((entry) => entry !== best).map((entry) => entry.path.join('.'));
    const warnings = [
      `Read ${records.length} record(s) from "${path}".`,
      carriedKeys.length > 0 ? `Copied ${carriedKeys.slice(0, LISTED).map((key) => `"${key}"`).join(', ')}${carriedKeys.length > LISTED ? ' and more' : ''} from around the list into every record.` : null,
      others.length > 0 ? `Other lists were left out: ${others.slice(0, LISTED).map((other) => `"${other}"`).join(', ')}${others.length > LISTED ? ', …' : ''}.` : null,
    ].filter(Boolean);
    return { records, kind: 'nested', path, warnings };
  }

  // id 로 묶인 객체들: 값이 모두 객체이고, 둘 이상이면 서로 같은 키가 있어야 한다 ({"meta": {…}, "body": {…}} 같은 기록 하나와 구별)
  const entries = Object.entries(value);
  const allObjects = entries.every(([, item]) => isObject(item));
  const shareKeys = allObjects && (entries.length === 1 || entries.slice(1).every(([, item]) => Object.keys(item).some((key) => key in entries[0][1])));
  if (shareKeys) {
    const keyName = entries.some(([, item]) => 'key' in item) ? 'record_key' : 'key';
    return { records: entries.map(([key, item]) => ({ [keyName]: key, ...item })), kind: 'map', path: '', warnings: [`Read ${entries.length} records keyed by name; the names are in "${keyName}".`] };
  }
  return { records: [value], kind: 'single', path: '', warnings: ['The file holds one record.'] };
}

/** JSON 이나 JSON Lines 글 → 표. 컬럼은 처음 나온 순서이고 값은 문자열이다. */
export function parseRecordsJson(text, fileName) {
  const hadBom = text.startsWith(BOM);
  const body = hadBom ? text.slice(1) : text;
  let parsed;
  let lines = false;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    parsed = parseLines(body);
    if (parsed === null) throw new DataFileError(`The file is not valid JSON or JSON Lines (${error.message}).`);
    lines = true;
  }
  const found = findRecords(parsed);
  // 경로가 . [ ] 와 빈칸으로 컬럼과 키를 나누므로 그런 글자는 _ 로 바꾼다. 빈 이름과 __proto__ 는 행의 키로 쓸 수 없어 버린다
  const nameOf = new Map();
  const used = new Set();
  const renamed = [];
  let dropped = 0;
  for (const record of found.records) {
    for (const key of Object.keys(record)) {
      if (nameOf.has(key)) continue;
      if (key.trim() === '' || key === '__proto__') {
        nameOf.set(key, null);
        dropped += 1;
        continue;
      }
      let name = key.trim().replace(/[\s.[\]]+/g, '_');
      while (used.has(name)) name = `${name}_`;
      used.add(name);
      nameOf.set(key, name);
      if (name !== key) renamed.push(`"${key}" → "${name}"`);
    }
  }
  const pairs = [...nameOf].filter(([, name]) => name !== null);
  if (pairs.length === 0) throw new DataFileError('The records have no usable keys.');
  const columns = pairs.map(([, name]) => name);
  const rows = found.records.map((record) => Object.fromEntries(pairs.map(([key, name]) => [name, cellText(record[key])])));
  const warnings = [
    ...(lines ? [`Read ${rows.length} line(s) of JSON Lines.`] : []),
    ...found.warnings,
    ...(renamed.length > 0 ? [`Renamed ${renamed.slice(0, LISTED).join(', ')}${renamed.length > LISTED ? ' and more' : ''}: names cannot hold spaces, dots or brackets.`] : []),
    ...(dropped > 0 ? [`${dropped} key(s) with an unusable name were dropped.`] : []),
  ];
  return { fileName, columns, rows, hadBom, warnings, source: { kind: lines ? 'lines' : found.kind, path: found.path, records: rows.length } };
}

/** File 또는 Blob 을 읽는다. */
export async function readRecordsFile(file) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await file.arrayBuffer());
  } catch {
    throw new DataFileError('The file is not valid UTF-8. Save it again as UTF-8 and upload it again.');
  }
  return parseRecordsJson(text, file.name ?? 'data.json');
}

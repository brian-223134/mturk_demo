// Publish Batch 의 HIT 데이터 읽기와 양식 만들기. 파일은 객체 하나가 HIT 하나인 JSON 배열이다: [{"컬럼": 값, …}, …]
// 템플릿의 `${}` 치환과 backend 는 셀을 문자열로 다루므로 값을 문자열로 바꾼다. 배열과 객체는 JSON 글이 되어 ann-checklist 항목이나
// attention 기대 답으로 그대로 읽힌다. 키가 없거나 null 인 칸은 빈 값이며 lib/data-check.js 의 빈 셀 경고가 알린다.

const BOM = '﻿';
const SHAPE = 'Upload a JSON array with one object per HIT, like [{"column": "value"}].';
const LISTED_ROWS = 5;

/** 파일을 쓸 수 없을 때. message 를 화면에 그대로 보여 준다. */
export class DataFileError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DataFileError';
  }
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cellText(value) {
  if (value === null || value === undefined) return '';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

/** JSON 글 → { fileName, columns, rows, hadBom, warnings }. 컬럼은 처음 나온 순서이고 행의 값은 모두 문자열이다. */
export function parseJsonData(text, fileName) {
  const hadBom = text.startsWith(BOM);
  let parsed;
  try {
    parsed = JSON.parse(hadBom ? text.slice(1) : text);
  } catch (error) {
    throw new DataFileError(`The file is not valid JSON (${error.message}). ${SHAPE}`);
  }
  if (!Array.isArray(parsed)) throw new DataFileError(`The file is JSON, but not an array. ${SHAPE}`);
  if (parsed.length === 0) throw new DataFileError('The JSON array is empty. Add one object per HIT.');
  const notObjects = parsed.flatMap((item, index) => (isObject(item) ? [] : [index + 1]));
  if (notObjects.length > 0) {
    const shown = notObjects.slice(0, LISTED_ROWS).join(', ');
    throw new DataFileError(`Item(s) ${shown}${notObjects.length > LISTED_ROWS ? ', …' : ''} are not objects. ${SHAPE}`);
  }

  const columns = [];
  const seen = new Set();
  let dropped = 0;
  for (const item of parsed) {
    for (const key of Object.keys(item)) {
      if (seen.has(key)) continue;
      seen.add(key);
      // __proto__ 는 행 객체의 키로 쓸 수 없다
      if (key.trim() === '' || key === '__proto__') dropped += 1;
      else columns.push(key);
    }
  }
  if (columns.length === 0) throw new DataFileError(`The objects have no keys. ${SHAPE}`);
  const rows = parsed.map((item) => Object.fromEntries(columns.map((column) => [column, cellText(item[column])])));
  const warnings = dropped > 0 ? [`${dropped} key(s) with an unusable name were dropped.`] : [];
  return { fileName, columns, rows, hadBom, warnings };
}

/** File 또는 Blob 을 읽는다. 브라우저의 업로드와 Node 테스트 양쪽에서 쓴다. */
export async function readJsonDataFile(file) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await file.arrayBuffer());
  } catch {
    throw new DataFileError('The file is not valid UTF-8. Save it again as UTF-8 and upload it again.');
  }
  return parseJsonData(text, file.name ?? 'data.json');
}

/** 칸에 든 JSON 글(항목 목록, 기대 답)은 양식에서 실제 배열과 객체로 보인다. */
function templateValue(cell) {
  if (typeof cell !== 'string' || !/^\s*[[{]/.test(cell)) return cell ?? '';
  try {
    return JSON.parse(cell);
  } catch {
    return cell;
  }
}

/** 컬럼을 키로, 표본 값을 값으로 둔 객체 하나짜리 JSON 글. "Download JSON template" 이 쓴다. 그대로 올리면 HIT 1개다. */
export function formatJsonTemplate(columns, sampleRow = {}) {
  const row = Object.fromEntries(columns.map((column) => [column, templateValue(sampleRow[column])]));
  return `${JSON.stringify([row], null, 2)}\n`;
}

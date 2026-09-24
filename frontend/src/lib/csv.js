// Create (2) Data: CSV 읽기. prototype/src/features/create/csv.ts 를 옮긴 것인데, papaparse 대신 작은 RFC 4180 파서를 직접 쓴다.
// 셀은 전부 문자열로 둔다 (`${}` 치환은 셀 문자열을 그대로 끼워 넣는다). 따옴표 안의 쉼표, 줄바꿈, 겹따옴표("")와 CRLF, BOM 을 다룬다.

/** 파일을 쓸 수 없을 때. message 를 화면에 그대로 보여 준다. */
export class CsvError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CsvError';
  }
}

const BOM = '﻿';
const LISTED_ROWS = 5;

/** 데이터 행 번호(1부터)를 몇 개만 나열한다. */
function listRows(indexes) {
  const shown = indexes
    .slice(0, LISTED_ROWS)
    .map((i) => i + 1)
    .join(', ');
  return indexes.length > LISTED_ROWS ? `${shown}, … (${indexes.length} rows)` : shown;
}

/**
 * 텍스트를 레코드(셀 배열)의 배열로 나눈다. 구분자는 쉼표, 레코드 끝은 \n, \r\n, \r 이다.
 * 따옴표로 감싼 셀 안에서는 쉼표와 줄바꿈이 글자이고 "" 는 " 하나다.
 * 돌려주는 값: { records, quoteProblems }. quoteProblems 는 닫히지 않은 따옴표, 닫는 따옴표 뒤에 글자가 이어지는 경우의 수다.
 */
export function splitRecords(text) {
  const records = [];
  let quoteProblems = 0;
  const length = text.length;
  let pos = 0;
  let record = [];

  while (pos <= length) {
    if (pos === length) {
      // 쉼표로 끝난 마지막 레코드("a,")의 빈 셀, 그리고 빈 파일의 빈 레코드 하나
      if (record.length > 0) record.push('');
      records.push(record);
      break;
    }
    let cell = '';
    let terminator; // ',' | '\n' | '\r' | undefined(EOF)
    if (text[pos] === '"') {
      // 따옴표 셀: 다음 " 를 찾아 가며 "" 는 " 로 푼다
      pos += 1;
      for (;;) {
        const quote = text.indexOf('"', pos);
        if (quote < 0) {
          cell += text.slice(pos);
          pos = length;
          quoteProblems += 1;
          break;
        }
        cell += text.slice(pos, quote);
        pos = quote + 1;
        if (text[pos] === '"') {
          cell += '"';
          pos += 1;
          continue;
        }
        break;
      }
      // 닫는 따옴표 뒤에는 구분자나 줄바꿈이 와야 한다. 다른 글자가 이어지면 그대로 붙이고 문제로 센다
      if (pos < length && text[pos] !== ',' && text[pos] !== '\n' && text[pos] !== '\r') {
        quoteProblems += 1;
        const end = nextBreak(text, pos);
        cell += text.slice(pos, end);
        pos = end;
      }
    } else {
      const end = nextBreak(text, pos);
      cell = text.slice(pos, end);
      pos = end;
    }
    if (pos < length) terminator = text[pos];
    record.push(cell);
    if (terminator === ',') {
      pos += 1;
      continue;
    }
    if (terminator === '\r') {
      pos += text[pos + 1] === '\n' ? 2 : 1;
    } else if (terminator === '\n') {
      pos += 1;
    } else {
      // EOF
      records.push(record);
      break;
    }
    records.push(record);
    record = [];
    if (pos === length) break; // 파일이 줄바꿈으로 끝났다: 빈 레코드를 더 만들지 않는다
  }
  return { records, quoteProblems };
}

const BREAK = /[,\r\n]/g;

function nextBreak(text, from) {
  BREAK.lastIndex = from;
  const m = BREAK.exec(text);
  return m ? m.index : text.length;
}

/** 중복된 헤더 이름을 papaparse 처럼 이름_1, 이름_2 로 바꾼다. renamed 는 { 새이름: 원래이름 } 이다. */
function renameDuplicates(fields) {
  const seen = new Set();
  const renamed = {};
  const out = fields.map((name) => {
    if (!seen.has(name)) {
      seen.add(name);
      return name;
    }
    let n = 1;
    let candidate = `${name}_${n}`;
    while (seen.has(candidate) || fields.includes(candidate)) {
      n += 1;
      candidate = `${name}_${n}`;
    }
    seen.add(candidate);
    renamed[candidate] = name;
    return candidate;
  });
  return { fields: out, renamed };
}

/**
 * CSV 텍스트 → { fileName, columns, rows, hadBom, warnings }.
 * 첫 레코드가 헤더다. 빈 줄(공백과 쉼표뿐인 줄 포함)은 건너뛴다. 이름이 빈 헤더의 컬럼은 버리고, 셀 수가 헤더와 다른 행은
 * 모자란 셀을 빈 값으로 채우고 넘치는 셀은 버린 뒤 warnings 에 적는다.
 */
export function parseCsv(text, fileName) {
  // BOM 을 그대로 두면 첫 컬럼 이름이 "﻿idx" 가 되어 ${idx} 와 맞지 않는다
  const hadBom = text.startsWith(BOM);
  const { records, quoteProblems } = splitRecords(hadBom ? text.slice(1) : text);

  const isBlank = (record) => record.every((cell) => cell.trim() === '');
  const nonBlank = records.filter((record) => !isBlank(record));
  const header = nonBlank[0] ?? [];
  const { fields, renamed } = renameDuplicates(header);
  const keep = fields.map((name) => name.trim() !== '');
  const columns = fields.filter((_, i) => keep[i]);
  if (columns.length === 0) throw new CsvError('The file has no header row.');
  const dataRecords = nonBlank.slice(1);
  if (dataRecords.length === 0) throw new CsvError('The file has a header row but no data rows.');

  const warnings = [];
  if (columns.length < fields.length) {
    warnings.push(`${fields.length - columns.length} column(s) with an empty header name were dropped.`);
  }
  const renamedEntries = Object.entries(renamed);
  if (renamedEntries.length > 0) {
    warnings.push(`Duplicate header names were renamed: ${renamedEntries.map(([to, from]) => `${from} → ${to}`).join(', ')}.`);
  }
  const mismatched = [];
  const rows = dataRecords.map((record, index) => {
    if (record.length !== fields.length) mismatched.push(index);
    const row = {};
    fields.forEach((name, i) => {
      if (!keep[i]) return;
      const cell = record[i];
      row[name] = typeof cell === 'string' ? cell : '';
    });
    return row;
  });
  if (mismatched.length > 0) {
    warnings.push(
      `Row(s) ${listRows(mismatched)} do not have ${fields.length} cells like the header. ` +
        'Missing cells were read as empty and extra cells were ignored.',
    );
  }
  if (quoteProblems > 0) {
    warnings.push(`${quoteProblems} quoting problem(s) were found. Check that quotes inside cells are doubled ("").`);
  }

  return { fileName, columns, rows, hadBom, warnings };
}

/**
 * 파일의 바이트를 UTF-8 로 읽는다. BOM 은 parseCsv 가 알 수 있게 남겨 둔다.
 * 한국어 Excel 이 기본으로 저장하는 CP949 파일은 여기서 걸러 낸다 (그대로 읽으면 글자가 깨진 채 게시된다).
 */
export function decodeUtf8(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new CsvError('The file is not valid UTF-8. Save it again as "CSV UTF-8" and upload it again.');
  }
}

/** File 또는 Blob 을 읽는다. 브라우저의 업로드와 Node 테스트 양쪽에서 쓴다. */
export async function readCsvFile(file) {
  return parseCsv(decodeUtf8(await file.arrayBuffer()), file.name ?? 'data.csv');
}

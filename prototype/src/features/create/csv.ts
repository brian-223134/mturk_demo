// 5.2 (2) Data: CSV 읽기. 셀은 전부 문자열로 둔다 (`${}` 치환은 셀 문자열을 그대로 끼워 넣는다, 5.5).

import Papa from 'papaparse';

export interface CsvData {
  fileName: string;
  columns: string[];
  rows: Record<string, string>[];
  /** 파일 맨 앞에 UTF-8 BOM이 있었는지. Excel이 저장한 CSV에 붙는다 */
  hadBom: boolean;
  /** 읽기는 했지만 사용자가 알아야 하는 것 (컬럼 수가 헤더와 다른 행 등) */
  warnings: string[];
}

/** 파일을 쓸 수 없을 때. message를 화면에 그대로 보여준다. */
export class CsvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CsvError';
  }
}

const BOM = '﻿';
const LISTED_ROWS = 5;

/** 데이터 행 번호(1부터)를 몇 개만 나열한다. */
function listRows(indexes: number[]): string {
  const shown = indexes.slice(0, LISTED_ROWS).map((i) => i + 1).join(', ');
  return indexes.length > LISTED_ROWS ? `${shown}, … (${indexes.length} rows)` : shown;
}

export function parseCsv(text: string, fileName: string): CsvData {
  // BOM을 그대로 두면 첫 컬럼 이름이 "﻿idx"가 되어 ${idx}와 맞지 않는다
  const hadBom = text.startsWith(BOM);
  const result = Papa.parse<Record<string, unknown>>(hadBom ? text.slice(1) : text, {
    header: true,
    skipEmptyLines: 'greedy',
    dynamicTyping: false,
  });

  const fields = result.meta.fields ?? [];
  const columns = fields.filter((name) => name.trim() !== '');
  if (columns.length === 0) throw new CsvError('The file has no header row.');
  if (result.data.length === 0) throw new CsvError('The file has a header row but no data rows.');

  const warnings: string[] = [];
  if (columns.length < fields.length) {
    warnings.push(`${fields.length - columns.length} column(s) with an empty header name were dropped.`);
  }
  const renamed = Object.entries(result.meta.renamedHeaders ?? {});
  if (renamed.length > 0) {
    warnings.push(
      `Duplicate header names were renamed: ${renamed.map(([to, from]) => `${from} → ${to}`).join(', ')}.`,
    );
  }
  const mismatched = new Set<number>();
  let quoteProblems = 0;
  for (const error of result.errors) {
    if (error.type === 'FieldMismatch' && error.row !== undefined) mismatched.add(error.row);
    if (error.type === 'Quotes') quoteProblems += 1;
  }
  if (mismatched.size > 0) {
    warnings.push(
      `Row(s) ${listRows([...mismatched].sort((a, b) => a - b))} do not have ${fields.length} cells like the header. ` +
        'Missing cells were read as empty and extra cells were ignored.',
    );
  }
  if (quoteProblems > 0) {
    warnings.push(`${quoteProblems} quoting problem(s) were found. Check that quotes inside cells are doubled ("").`);
  }

  // 컬럼 수가 모자란 행은 키가 빠져 있고, 넘치는 행은 __parsed_extra가 붙어 있다. 모든 행을 같은 모양으로 맞춘다.
  const rows = result.data.map((raw) => {
    const row: Record<string, string> = {};
    for (const column of columns) {
      const cell = raw[column];
      row[column] = typeof cell === 'string' ? cell : '';
    }
    return row;
  });

  return { fileName, columns, rows, hadBom, warnings };
}

/**
 * 파일의 바이트를 UTF-8로 읽는다. BOM은 parseCsv가 알 수 있게 남겨 둔다.
 * 한국어 Excel이 기본으로 저장하는 CP949 파일은 여기서 걸러 낸다 (그대로 읽으면 글자가 깨진 채 게시된다).
 */
export function decodeUtf8(bytes: ArrayBuffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new CsvError('The file is not valid UTF-8. Save it again as "CSV UTF-8" and upload it again.');
  }
}

export async function readCsvFile(file: Blob & { name?: string }): Promise<CsvData> {
  return parseCsv(decodeUtf8(await file.arrayBuffer()), file.name ?? 'data.csv');
}

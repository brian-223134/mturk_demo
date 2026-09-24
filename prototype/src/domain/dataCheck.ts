// 5.2 Create (2) Data 단계의 검증: placeholder와 CSV 컬럼 대조, 빈 셀, 행별 입력 크기

import { median } from './workerStats';

/** MTurk API의 Question 크기 제한 (11장). HTMLQuestion에 데이터를 넣으면 이 크기를 넘을 수 없다. */
export const QUESTION_SIZE_LIMIT_BYTES = 64 * 1024;

export interface DataCheck {
  rowCount: number;
  columnCount: number;
  matchedPlaceholders: string[];
  /** 템플릿에는 있는데 CSV에 없는 컬럼. 치환되지 않은 `${x}`는 템플릿의 JS를 깨뜨리므로 오류다. */
  missingColumns: string[];
  /** CSV에만 있고 템플릿이 쓰지 않는 컬럼. 안내만 한다. TASK_DATA 방식 템플릿은 placeholder가 없어 전부 여기에 든다. */
  unusedColumns: string[];
  /** 빈 셀이 있는 행 번호 (0부터) */
  rowsWithEmptyCells: number[];
  rowSizeMedianBytes: number;
  rowSizeMaxBytes: number;
  rowsOverQuestionLimit: number;
}

const encoder = new TextEncoder();

export function rowSizeBytes(row: Record<string, string>): number {
  let size = 0;
  for (const cell of Object.values(row)) size += encoder.encode(cell).length;
  return size;
}

export function checkData(
  placeholders: string[],
  columns: string[],
  rows: Record<string, string>[],
): DataCheck {
  const columnSet = new Set(columns);
  const placeholderSet = new Set(placeholders);
  const sizes = rows.map(rowSizeBytes);
  return {
    rowCount: rows.length,
    columnCount: columns.length,
    matchedPlaceholders: placeholders.filter((p) => columnSet.has(p)),
    missingColumns: placeholders.filter((p) => !columnSet.has(p)),
    unusedColumns: columns.filter((c) => !placeholderSet.has(c)),
    rowsWithEmptyCells: rows.flatMap((row, index) =>
      columns.some((c) => (row[c] ?? '').trim() === '') ? [index] : [],
    ),
    rowSizeMedianBytes: median(sizes) ?? 0,
    rowSizeMaxBytes: sizes.length === 0 ? 0 : Math.max(...sizes),
    rowsOverQuestionLimit: sizes.filter((s) => s > QUESTION_SIZE_LIMIT_BYTES).length,
  };
}

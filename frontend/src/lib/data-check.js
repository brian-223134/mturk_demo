// Create (2) Data 단계의 검증: placeholder 와 CSV 컬럼 대조, 빈 셀, 행별 입력 크기. prototype/src/domain/dataCheck.ts 와
// DataStep 의 검사 줄(ERROR / OK / WARN / INFO)을 옮겼다. 검사 줄은 화면과 무관한 데이터로 만들어 Node 에서 테스트한다.

/** MTurk API 의 Question 크기 제한. HTMLQuestion 에 데이터를 넣으면 이 크기를 넘을 수 없다. */
export const QUESTION_SIZE_LIMIT_BYTES = 64 * 1024;

const LISTED_ITEMS = 8;
const encoder = new TextEncoder();

export function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function rowSizeBytes(row) {
  let size = 0;
  for (const cell of Object.values(row)) size += encoder.encode(cell).length;
  return size;
}

/**
 * { rowCount, columnCount, matchedPlaceholders, missingColumns, unusedColumns, rowsWithEmptyCells(0부터), rowSizeMedianBytes,
 *   rowSizeMaxBytes, rowsOverQuestionLimit }.
 * missingColumns 는 템플릿에는 있는데 CSV 에 없는 컬럼이다. 치환되지 않은 `${x}` 는 템플릿의 JS 를 깨뜨리므로 오류다.
 * unusedColumns 는 CSV 에만 있고 템플릿이 쓰지 않는 컬럼이다. TASK_DATA 방식 템플릿은 placeholder 가 없어 전부 여기에 든다.
 */
export function checkData(placeholders, columns, rows) {
  const columnSet = new Set(columns);
  const placeholderSet = new Set(placeholders);
  const sizes = rows.map(rowSizeBytes);
  return {
    rowCount: rows.length,
    columnCount: columns.length,
    matchedPlaceholders: placeholders.filter((p) => columnSet.has(p)),
    missingColumns: placeholders.filter((p) => !columnSet.has(p)),
    unusedColumns: columns.filter((c) => !placeholderSet.has(c)),
    rowsWithEmptyCells: rows.flatMap((row, index) => (columns.some((c) => (row[c] ?? '').trim() === '') ? [index] : [])),
    rowSizeMedianBytes: median(sizes) ?? 0,
    rowSizeMaxBytes: sizes.length === 0 ? 0 : Math.max(...sizes),
    rowsOverQuestionLimit: sizes.filter((s) => s > QUESTION_SIZE_LIMIT_BYTES).length,
  };
}

export function listSome(items) {
  const shown = items.slice(0, LISTED_ITEMS).join(', ');
  return items.length > LISTED_ITEMS ? `${shown}, … (+${items.length - LISTED_ITEMS} more)` : shown;
}

export function formatBytes(bytes) {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

/**
 * Placeholder check 의 줄들. 각 줄은 { level: 'error'|'ok'|'warn'|'info', key, text, names?, note? } 다.
 *  - text 는 줄의 본문, names 는 본문 뒤에 `${이름}` 태그로 붙일 목록, note 는 그 아래 흐린 글씨의 설명이다.
 * 프로토타입 DataStep 의 문구와 같다 (README 의 시나리오 표가 이 문구를 인용한다).
 */
export function checkLines(check, placeholders) {
  const usesTaskData = placeholders.length === 0;
  const lines = [];
  if (check.missingColumns.length > 0) {
    lines.push({
      level: 'error',
      key: 'missing',
      text: `${check.missingColumns.length} placeholder(s) have no matching CSV column:`,
      names: check.missingColumns,
      note: "An unsubstituted ${x} stays in the page as it is and breaks the template's JavaScript. Add the column(s) to the CSV, or go back and choose another template.",
    });
  }
  if (usesTaskData) {
    lines.push({
      level: 'ok',
      key: 'task-data',
      text: 'This template has no ${...} placeholders. It reads the row from window.TASK_DATA, so there is nothing to match.',
    });
  } else if (check.matchedPlaceholders.length > 0) {
    lines.push({
      level: check.missingColumns.length > 0 ? 'info' : 'ok',
      key: 'matched',
      text: `${check.matchedPlaceholders.length}/${placeholders.length} matched with a CSV column:`,
      names: check.matchedPlaceholders,
    });
  }
  if (check.unusedColumns.length > 0) {
    lines.push(
      usesTaskData
        ? {
            level: 'info',
            key: 'unused',
            text: `${check.unusedColumns.length} column(s) are available to the template through window.TASK_DATA: ${listSome(check.unusedColumns)}. Not a problem.`,
          }
        : {
            level: 'warn',
            key: 'unused',
            text: `${check.unusedColumns.length} column(s) not used by the template: ${listSome(check.unusedColumns)}. They are still stored with each HIT.`,
          },
    );
  }
  if (check.rowsWithEmptyCells.length > 0) {
    lines.push({
      level: 'warn',
      key: 'empty',
      text: `${check.rowsWithEmptyCells.length} row(s) have empty cells: row ${listSome(check.rowsWithEmptyCells.map((index) => String(index + 1)))}.`,
    });
  }
  let size = `Row input size: median ${formatBytes(Math.round(check.rowSizeMedianBytes))}, max ${formatBytes(check.rowSizeMaxBytes)}.`;
  if (check.rowsOverQuestionLimit > 0) {
    size += ` ${check.rowsOverQuestionLimit} row(s) exceed MTurk's ${QUESTION_SIZE_LIMIT_BYTES / 1024} KB Question limit, so the MTurk integration will have to publish this batch as an ExternalQuestion. The mock environment is not affected.`;
  }
  lines.push({ level: check.rowsOverQuestionLimit > 0 ? 'warn' : 'info', key: 'size', text: size });
  return lines;
}

/** 파일 줄의 요약: "10 rows, 5 columns, UTF-8 (BOM removed)" */
export function describeCsv(check, hadBom) {
  return `${check.rowCount.toLocaleString('en-US')} rows, ${check.columnCount} columns, UTF-8${hadBom ? ' (BOM removed)' : ''}`;
}

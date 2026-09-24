// 목록 API의 { page, pageSize, sort, filters } 처리. 서버식 페이지네이션을 mock에서 흉내 낸다 (명세 9장).

import { ApiError, type ListQuery, type ListResult } from '../types';

const MAX_PAGE_SIZE = 1000;

/** "stats.rejectRate" 같은 점 표기 경로의 값을 읽는다. */
export function valueAt(item: unknown, path: string): unknown {
  let current: unknown = item;
  for (const key of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function isEmptyFilter(value: unknown): boolean {
  return value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);
}

function compare(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  return String(a).localeCompare(String(b));
}

export interface ListQueryOptions<T> {
  /** 단순 일치로 처리할 수 없는 필터. 여기서 처리한 키는 일반 필터에서 빠진다. */
  customFilters?: Record<string, (item: T, value: unknown) => boolean>;
}

/**
 * 필터 값이 배열이면 "그중 하나와 일치", 아니면 "같음"이다. 빈 값은 필터가 없는 것으로 본다.
 * 정렬에서 null과 undefined는 방향과 무관하게 맨 뒤로 보낸다.
 */
export function applyListQuery<T>(
  items: readonly T[],
  query: ListQuery,
  options: ListQueryOptions<T> = {},
): ListResult<T> {
  if (typeof query !== 'object' || query === null) {
    throw new ApiError('INVALID_REQUEST', 'A list query ({ page, pageSize }) is required.');
  }
  const { page, pageSize, sort, filters } = query;
  if (!Number.isInteger(page) || page < 1) {
    throw new ApiError('INVALID_REQUEST', `page must be an integer ≥ 1 (got ${page})`);
  }
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    throw new ApiError('INVALID_REQUEST', `pageSize must be between 1 and ${MAX_PAGE_SIZE} (got ${pageSize})`);
  }

  let result = [...items];

  for (const [field, expected] of Object.entries(filters ?? {})) {
    if (isEmptyFilter(expected)) continue;
    const custom = options.customFilters?.[field];
    if (custom) {
      result = result.filter((item) => custom(item, expected));
    } else if (Array.isArray(expected)) {
      result = result.filter((item) => expected.includes(valueAt(item, field)));
    } else {
      result = result.filter((item) => valueAt(item, field) === expected);
    }
  }

  if (sort) {
    const direction = sort.order === 'desc' ? -1 : 1;
    result.sort((x, y) => {
      const a = valueAt(x, sort.field);
      const b = valueAt(y, sort.field);
      const aMissing = a === null || a === undefined;
      const bMissing = b === null || b === undefined;
      if (aMissing || bMissing) return Number(aMissing) - Number(bMissing);
      return direction * compare(a, b);
    });
  }

  const start = (page - 1) * pageSize;
  return { items: result.slice(start, start + pageSize), total: result.length };
}

// Worker Pool 화면들이 함께 쓰는 것: 변경 뒤에 다시 불러올 쿼리, 문구, 입력 디바운스

import type { QueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

/** 5.4: 차단 대신 쓰는 제외용 pool. fixture에 들어 있고, 없으면 화면이 pool을 직접 고르게 한다. */
export const EXCLUDED_POOL_ID = 'pool-excluded';

/** pool 변경과 차단은 worker 목록, pool 인원, worker 상세에 함께 드러나므로 한곳에서 무효화한다. */
export async function invalidateWorkerData(queryClient: QueryClient): Promise<void> {
  await Promise.all(
    [['workers'], ['pools'], ['worker']].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
  );
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function countWorkers(count: number): string {
  return `${count} worker${count === 1 ? '' : 's'}`;
}

/** 입력이 멈춘 뒤의 값. 숫자를 고치는 동안 매번 조회하지 않게 한다. */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

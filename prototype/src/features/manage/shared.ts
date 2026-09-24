// Manage 화면들이 함께 쓰는 것: 변경 뒤에 다시 불러올 쿼리, 검수 문구, 재모집 결과 요약

import type { QueryClient } from '@tanstack/react-query';
import type { AddAssignmentsResult } from '../../api/types';

/** 5.3: 케이스 스터디에서 실제로 쓴 반려 사유 */
export const REJECT_PRESETS = [
  'Failed to pass the attention check task.',
  'Keeps responding with error responses.',
  'Poor Quality.',
];

/**
 * 검수와 재모집은 batch의 진행률과 비용, 표, 결과, worker 지표, 잔액을 한꺼번에 바꾼다.
 * 화면마다 따로 챙기면 빠뜨리기 쉬워서 한곳에서 무효화한다.
 */
export async function invalidateBatchData(queryClient: QueryClient, batchId: string): Promise<void> {
  await Promise.all(
    [['batch', batchId], ['batches'], ['assignments', batchId], ['hits', batchId], ['hit-assignments'], ['results', batchId], ['workers'], ['worker'], ['account']].map(
      (queryKey) => queryClient.invalidateQueries({ queryKey }),
    ),
  );
}

export function describeTopUp(result: AddAssignmentsResult): { title: string; lines: string[] } {
  const addedTotal = result.added.reduce((sum, a) => sum + a.count, 0);
  const withNew = result.added.filter((a) => a.count > 0).length;
  const extended = result.added.filter((a) => a.expirationExtended).length;
  const lines: string[] = [];
  if (addedTotal > 0) lines.push(`Added ${addedTotal} assignment(s) across ${withNew} HIT(s).`);
  if (extended > 0) lines.push(`Extended the expiration of ${extended} expired HIT(s) so workers can see them again.`);
  const reasons = new Map<string, number>();
  for (const s of result.skipped) reasons.set(s.reason, (reasons.get(s.reason) ?? 0) + 1);
  for (const [reason, count] of reasons) lines.push(`Skipped ${count} HIT(s): ${reason}`);
  return {
    title: result.added.length > 0 ? 'Top-up done' : 'Nothing to top up',
    lines: lines.length > 0 ? lines : ['No HITs needed more assignments.'],
  };
}

// Review의 대조 기준 출처를 화면 문구로. 표의 범례와 응답 상세 Drawer가 같이 쓴다.

import type { ReviewReference } from '../../api/types';

/** `batch.reference`가 없는 옛 저장본은 majority로 본다 */
export function describeReferenceSource(reference: ReviewReference | undefined): string {
  return reference?.source === 'column' ? `input column "${reference.column}"` : 'majority of the other workers on the HIT';
}

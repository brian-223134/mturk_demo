// Manage 의 탭들이 함께 쓰는 것: 반려 사유 프리셋, 대조 기준 문구, attention 문항 판별, 오류 문구.

export const DEFAULT_ATTENTION_PREFIX = 'attention_';

/** 케이스 스터디에서 실제로 쓴 반려 사유 */
export const REJECT_PRESETS = ['Failed to pass the attention check task.', 'Keeps responding with error responses.', 'Poor Quality.'];

export function isAttentionName(name, prefix = DEFAULT_ATTENTION_PREFIX) {
  return String(name).startsWith(prefix);
}

export function attentionPrefixOf(batch) {
  return batch?.attentionRule?.namePrefix ?? DEFAULT_ATTENTION_PREFIX;
}

/** `batch.reference` 가 없는 옛 저장본은 majority 로 본다 */
export function describeReferenceSource(reference) {
  return reference?.source === 'column' ? `input column "${reference.column}"` : 'majority of the other workers on the HIT';
}

export function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

export function batchPath(batchId, tab) {
  return `/manage/${encodeURIComponent(batchId)}${tab ? `/${tab}` : ''}`;
}

export function workerPath(workerId) {
  return `/workers/${encodeURIComponent(workerId)}`;
}

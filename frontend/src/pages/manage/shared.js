// Manage 의 탭들이 함께 쓰는 것: 반려 사유 프리셋, 대조 기준 문구, attention 과 자유 서술 답 판별, 오류 문구.

export const DEFAULT_ATTENTION_PREFIX = 'attention_';

/** 케이스 스터디에서 실제로 쓴 반려 사유 */
export const REJECT_PRESETS = ['Failed to pass the attention check task.', 'Keeps responding with error responses.', 'Poor Quality.'];

export function isAttentionName(name, prefix = DEFAULT_ATTENTION_PREFIX) {
  return String(name).startsWith(prefix);
}

export function attentionPrefixOf(batch) {
  return batch?.attentionRule?.namePrefix ?? DEFAULT_ATTENTION_PREFIX;
}

/**
 * assignment 의 답 이름 분류 { isAttention(name), isFreeText(name) }. backend 의 listAssignments 가 준 attentionNames 와
 * freeTextNames 가 있으면 그것을 쓴다 (기대 답 컬럼 방식은 HIT 마다 다르고 이름으로 가릴 수 없다). 없으면(옛 서버, prototype 의 mock API)
 * attention 은 접두어로, 자유 서술은 batch.freeTextSuffixes 의 접미어로 판단한다.
 */
export function answerKindsOf(assignment, batch) {
  const suffixes = Array.isArray(batch?.freeTextSuffixes) ? batch.freeTextSuffixes : [];
  const prefix = attentionPrefixOf(batch);
  const attention = Array.isArray(assignment?.attentionNames) ? new Set(assignment.attentionNames) : null;
  const freeText = Array.isArray(assignment?.freeTextNames) ? new Set(assignment.freeTextNames) : null;
  const isAttention = (name) => (attention ? attention.has(name) : isAttentionName(name, prefix));
  const isFreeText = (name) => (freeText ? freeText.has(name) : !isAttention(name) && suffixes.some((suffix) => String(name).endsWith(suffix)));
  return { isAttention, isFreeText };
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

// Results 의 annotator 간 일치도(IAA). backend 의 getResults 가 주는 iaa = { approved, pending, submitted } 를 표의 행으로 바꾼다.
// 범위: 승인된 응답, 승인하지 않은 제출(검수 대기), 검수 대기 + 승인. 반려된 응답은 어느 범위에도 없다.
// 지표: Fleiss' κ(투표가 정확히 target 인 문항만), Krippendorff's α(투표 2개 이상인 문항 모두, nominal). DOM 을 쓰지 않으므로 Node 에서 테스트한다.

import { formatFixed } from '../../components/format.js';

export const IAA_SCOPES = [
  { key: 'approved', label: 'Approved', detail: 'approved responses' },
  { key: 'pending', label: 'Submitted, not approved', detail: 'waiting for review' },
  { key: 'submitted', label: 'Submitted, with approved', detail: 'waiting for review + approved' },
];

/** Landis & Koch (1977) 의 구간. 해석을 돕는 관례일 뿐 기준은 아니다. */
export function kappaBand(kappa) {
  if (kappa < 0) return 'poor';
  if (kappa <= 0.2) return 'slight';
  if (kappa <= 0.4) return 'fair';
  if (kappa <= 0.6) return 'moderate';
  if (kappa <= 0.8) return 'substantial';
  return 'almost perfect';
}

/** Krippendorff (2004) 의 권고: 0.800 이상이면 믿을 만하고, 0.667 이상이면 잠정적인 결론에만 쓴다. */
export function alphaBand(alpha) {
  if (alpha >= 0.8) return 'reliable';
  if (alpha >= 0.667) return 'tentative';
  return 'unreliable';
}

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** 범위 하나의 표 행에 들어갈 글: 값, 해석, 그 값을 계산한 문항 범위. */
export function iaaRow(scope, target) {
  const kappa = scope?.fleissKappa;
  const alpha = scope?.krippendorffAlpha;
  return {
    kappa: formatFixed(kappa),
    kappaBand: isNumber(kappa) ? kappaBand(kappa) : 'not enough votes',
    kappaCoverage: `${scope?.kappaItemCount ?? 0} of ${plural(scope?.items ?? 0, 'item')} × ${target} votes`,
    alpha: formatFixed(alpha),
    alphaBand: isNumber(alpha) ? alphaBand(alpha) : 'not enough votes',
    alphaCoverage: `${plural(scope?.alphaItemCount ?? 0, 'item')} with 2+ votes`,
    responses: `${plural(scope?.assignments ?? 0, 'response')} from ${plural(scope?.workers ?? 0, 'worker')}`,
  };
}

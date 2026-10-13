// Results 의 annotator 간 일치도(IAA). backend 의 getResults 가 주는 iaa = { submitted, approved } 를 표의 행으로 바꾼다.
// 범위: 제출 전체(검수 대기, 승인, 반려 모두)와 승인만. 지표: Fleiss' κ(투표가 정확히 target 인 문항만), Krippendorff's α(투표 2개 이상인
// 문항 모두, nominal). DOM 을 쓰지 않으므로 Node 에서 테스트한다.

import { formatFixed } from '../../components/format.js';

export const IAA_SCOPES = [
  { key: 'submitted', label: 'All submitted', detail: 'pending, approved and rejected' },
  { key: 'approved', label: 'Approved only', detail: 'after review' },
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

/** 승인만 − 제출 전체. 둘 중 하나라도 없으면 null. 검수로 일치도가 얼마나 바뀌었는지 본다 */
export function iaaChange(iaa, metric) {
  const before = iaa?.submitted?.[metric];
  const after = iaa?.approved?.[metric];
  return isNumber(before) && isNumber(after) ? after - before : null;
}

export function formatChange(change) {
  if (!isNumber(change)) return '—';
  const text = Math.abs(change).toFixed(3);
  return change > 0 ? `+${text}` : change < 0 ? `−${text}` : '±0.000';
}

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

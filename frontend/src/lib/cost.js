// 비용 견적. prototype/src/domain/cost.ts 를 옮겼다. 금액은 센트 단위 숫자로 계산한다 (부동소수 오차를 피하려고 수수료율도 정수 % 로 둔다).

// 연동 전에 MTurk 공식 요금표로 다시 확인한다.
export const FEE_PERCENT = 20;
export const FEE_PERCENT_10_OR_MORE = 40; // MaxAssignments ≥ 10
export const MASTERS_EXTRA_PERCENT = 5;
export const MIN_FEE_CENTS = 1; // assignment 당 최소 수수료 $0.01
export const HIGH_FEE_MIN_ASSIGNMENTS = 10;

// Masters Qualification ID. 1단계에서는 쓰이지 않으며, 이 값도 연동 전에 공식 문서로 확인한다.
export const MASTERS_QUALIFICATION_TYPE_IDS = [
  '2F1QJWKUDD8XADTFD2Q0G6UTO95ALH', // production
  '2ARFPLSP75KLA8M8DH1HTEQVJT3SY6', // sandbox
];

export function rewardToCents(reward) {
  const dollars = Number.parseFloat(reward);
  if (!Number.isFinite(dollars) || dollars < 0) {
    throw new RangeError(`Invalid Reward: ${JSON.stringify(reward)}`);
  }
  return Math.round(dollars * 100);
}

export function usesMasters(requirements) {
  return requirements.some((r) => MASTERS_QUALIFICATION_TYPE_IDS.includes(r.QualificationTypeId));
}

export function feePercent(maxAssignments, masters) {
  const base = maxAssignments >= HIGH_FEE_MIN_ASSIGNMENTS ? FEE_PERCENT_10_OR_MORE : FEE_PERCENT;
  return base + (masters ? MASTERS_EXTRA_PERCENT : 0);
}

export function feeCentsPerAssignment(rewardCents, percent) {
  return Math.max((rewardCents * percent) / 100, MIN_FEE_CENTS);
}

/** 게시 전 견적 { rewardCents, feeCents, totalCents, feePercent }. 반려 후 재모집분은 포함되지 않는다. */
export function estimateCost(input) {
  const assignments = input.hitCount * input.maxAssignments;
  const percent = feePercent(input.maxAssignments, input.masters);
  const rewardCents = assignments * rewardToCents(input.reward);
  const feeCents = assignments * feeCentsPerAssignment(rewardToCents(input.reward), percent);
  return { rewardCents, feeCents, totalCents: rewardCents + feeCents, feePercent: percent };
}

/**
 * 게시된 batch 의 지출과 예상 총액 { spentCents, estimatedCents }.
 * 지출은 Approved 만 센다 (반려분은 과금되지 않는다). 예상은 반려를 뺀 모든 자리가 승인된다고 볼 때의 총액이다.
 */
export function batchCost(hits, reward, masters) {
  const rewardCents = rewardToCents(reward);
  let spentCents = 0;
  let estimatedCents = 0;
  for (const hit of hits) {
    const unit = rewardCents + feeCentsPerAssignment(rewardCents, feePercent(hit.MaxAssignments, masters));
    spentCents += hit.approved * unit;
    estimatedCents += Math.max(0, hit.MaxAssignments - hit.rejected) * unit;
  }
  return { spentCents, estimatedCents };
}

export function formatCents(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

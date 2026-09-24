// 재모집(assignment 추가)의 순수 계산. 서버가 같은 규칙으로 판정하지만, 확인 창의 수와 비용을 미리 보여 주려고 여기서도 계산한다.
//   - MTurk 제약: 처음에 MaxAssignments 를 10 미만으로 만든 HIT 는 추가해도 합계가 9 를 넘을 수 없다.
//   - 수수료: HIT 의 MaxAssignments 가 10 이상이면 40%, 아니면 20%. Masters 자격이 있으면 +5%. assignment 당 최소 $0.01.

export const MAX_TOTAL_WHEN_CREATED_UNDER_10 = 9;
export const HIGH_VOLUME_THRESHOLD = 10;
/** 프로토타입의 "Add a fixed number" 입력 상한: 1개로 만든 HIT 도 9개까지 갈 수 있으므로 최대 +8 */
export const MAX_FIXED_ADD = MAX_TOTAL_WHEN_CREATED_UNDER_10 - 1;

export const FEE_PERCENT = 20;
export const FEE_PERCENT_10_OR_MORE = 40;
export const MASTERS_EXTRA_PERCENT = 5;
export const MIN_FEE_CENTS = 1;
const MASTERS_QUALIFICATION_TYPE_IDS = ['2F1QJWKUDD8XADTFD2Q0G6UTO95ALH', '2ARFPLSP75KLA8M8DH1HTEQVJT3SY6'];

/**
 * HIT 1개에 assignment 를 몇 개 추가할지. mode 가 숫자면 그만큼, 'fill-to-target' 이면 부족분(progress.shortfall)만큼이다.
 * 상한을 넘으면 일부만 추가하지 않고 그 HIT 를 건너뛴다 (일부만 추가해도 목표를 채울 수 없다). → { add, reason? }
 */
export function planTopUp(hit, progress, mode) {
  const requested = mode === 'fill-to-target' ? progress.shortfall : mode;
  if (!Number.isInteger(requested) || requested < 0) {
    throw new RangeError(`Invalid number of assignments to add: ${String(mode)}`);
  }
  if (requested === 0) {
    return { add: 0, reason: 'No shortfall: open and submitted assignments already cover the target.' };
  }
  if (hit.initialMaxAssignments < HIGH_VOLUME_THRESHOLD) {
    const room = MAX_TOTAL_WHEN_CREATED_UNDER_10 - hit.MaxAssignments;
    if (requested > room) {
      return {
        add: 0,
        reason: `MTurk limit: a HIT created with fewer than 10 assignments cannot exceed ${MAX_TOTAL_WHEN_CREATED_UNDER_10} (now ${hit.MaxAssignments}, requested +${requested}).`,
      };
    }
  }
  return { add: requested };
}

/** HIT 하나에 더 넣을 수 있는 수. 10개 이상으로 만든 HIT 는 제한이 없어 Infinity 다. */
export function roomOf(hit) {
  if (hit.initialMaxAssignments >= HIGH_VOLUME_THRESHOLD) return Infinity;
  return Math.max(0, MAX_TOTAL_WHEN_CREATED_UNDER_10 - hit.MaxAssignments);
}

/** 선택한 HIT 전부에 같은 수를 넣을 때 건너뛰는 HIT 없이 넣을 수 있는 최대. 빈 목록이면 Infinity. */
export function maxAddable(hits) {
  return hits.reduce((min, hit) => Math.min(min, roomOf(hit)), Infinity);
}

export function rewardToCents(reward) {
  const dollars = Number.parseFloat(reward);
  if (!Number.isFinite(dollars) || dollars < 0) throw new RangeError(`Invalid Reward: ${JSON.stringify(reward)}`);
  return Math.round(dollars * 100);
}

export function usesMasters(requirements) {
  return (requirements ?? []).some((r) => MASTERS_QUALIFICATION_TYPE_IDS.includes(r.QualificationTypeId));
}

export function feePercent(maxAssignments, masters) {
  const base = maxAssignments >= HIGH_VOLUME_THRESHOLD ? FEE_PERCENT_10_OR_MORE : FEE_PERCENT;
  return base + (masters ? MASTERS_EXTRA_PERCENT : 0);
}

export function feeCentsPerAssignment(rewardCents, percent) {
  return Math.max((rewardCents * percent) / 100, MIN_FEE_CENTS);
}

/** assignment 1건의 값 (reward + 수수료). HIT 의 MaxAssignments 에 따라 수수료율이 달라진다. */
export function unitCostCents(batch, hit) {
  const reward = rewardToCents(batch.settings.Reward);
  return reward + feeCentsPerAssignment(reward, feePercent(hit.MaxAssignments, usesMasters(batch.settings.QualificationRequirements)));
}

/** 재모집 계획: 실제로 추가될 수와 비용, 건너뛸 HIT 수. 서버의 addAssignments 와 같은 규칙이다. */
export function planBatchTopUp(batch, hits, mode) {
  let addTotal = 0;
  let costCents = 0;
  let hitsAdded = 0;
  let skipped = 0;
  for (const hit of hits) {
    const plan = planTopUp(hit, hit.progress, mode);
    if (plan.add === 0) {
      skipped += 1;
      continue;
    }
    hitsAdded += 1;
    addTotal += plan.add;
    costCents += plan.add * unitCostCents(batch, hit);
  }
  return { addTotal, costCents, hitsAdded, skipped };
}

/** addAssignments 의 결과를 알림 문장으로. */
export function describeTopUp(result) {
  const addedTotal = result.added.reduce((sum, a) => sum + a.count, 0);
  const withNew = result.added.filter((a) => a.count > 0).length;
  const extended = result.added.filter((a) => a.expirationExtended).length;
  const lines = [];
  if (addedTotal > 0) lines.push(`Added ${addedTotal} assignment(s) across ${withNew} HIT(s).`);
  if (extended > 0) lines.push(`Extended the expiration of ${extended} expired HIT(s) so workers can see them again.`);
  const reasons = new Map();
  for (const s of result.skipped) reasons.set(s.reason, (reasons.get(s.reason) ?? 0) + 1);
  for (const [reason, count] of reasons) lines.push(`Skipped ${count} HIT(s): ${reason}`);
  return {
    title: result.added.length > 0 ? 'Top-up done' : 'Nothing to top up',
    lines: lines.length > 0 ? lines : ['No HITs needed more assignments.'],
  };
}

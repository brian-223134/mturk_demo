// 8.4 Majority와 Fleiss κ

/** 문항 키. 라벨 JSON export(5.3)의 키와 같다. */
export function itemKey(rowIndex: number, answerName: string): string {
  return `${rowIndex}:${answerName}`;
}

export function tally(votes: Iterable<string>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const v of votes) counts.set(v, (counts.get(v) ?? 0) + 1);
  return counts;
}

/** 최다 득표 값. 표가 없거나 동률이면 null이다. */
export function majorityOfTally(counts: ReadonlyMap<string, number>): string | null {
  let best: string | null = null;
  let bestCount = 0;
  let tied = false;
  for (const [value, count] of counts) {
    if (count <= 0) continue;
    if (count > bestCount) {
      best = value;
      bestCount = count;
      tied = false;
    } else if (count === bestCount) {
      tied = true;
    }
  }
  return tied ? null : best;
}

export function majority(votes: string[]): string | null {
  return majorityOfTally(tally(votes));
}

// ---------------------------------------------------------------------------
// Results 화면 (5.3)과 Review 표의 Agree 열

export interface Vote {
  rowIndex: number;
  answerName: string;
  value: string;
  workerId: string;
}

export interface VotedItem {
  key: string;
  rowIndex: number;
  answerName: string;
  votes: string[];
  workers: string[]; // votes와 같은 순서
  majority: string | null;
  unanimous: boolean;
}

/** 표를 문항별로 묶는다. 어떤 표를 넣을지(Approved만, attention 제외)는 호출하는 쪽에서 정한다. */
export function collectItems(votes: Iterable<Vote>): VotedItem[] {
  const byKey = new Map<string, VotedItem>();
  for (const v of votes) {
    const key = itemKey(v.rowIndex, v.answerName);
    let item = byKey.get(key);
    if (!item) {
      item = { key, rowIndex: v.rowIndex, answerName: v.answerName, votes: [], workers: [], majority: null, unanimous: false };
      byKey.set(key, item);
    }
    item.votes.push(v.value);
    item.workers.push(v.workerId);
  }
  const items = [...byKey.values()];
  for (const item of items) {
    item.majority = majority(item.votes);
    item.unanimous = item.votes.length > 1 && new Set(item.votes).size === 1;
  }
  return items.sort((a, b) => a.rowIndex - b.rowIndex || a.answerName.localeCompare(b.answerName, undefined, { numeric: true }));
}

/**
 * Fleiss' κ. 모든 문항의 투표 수가 같아야 한다 (평가자 n명).
 *
 *   P_i = (Σ_j n_ij² - n) / (n(n-1)),  P̄ = mean(P_i),  p_j = Σ_i n_ij / (N·n),  P̄e = Σ_j p_j²
 *   κ = (P̄ - P̄e) / (1 - P̄e)
 *
 * 문항이 없거나, n < 2이거나, 모든 표가 한 범주라 P̄e = 1이면 정의되지 않으므로 null이다.
 */
export function fleissKappa(items: string[][]): number | null {
  const N = items.length;
  if (N === 0) return null;
  const n = items[0]!.length;
  if (n < 2) return null;
  if (items.some((votes) => votes.length !== n)) {
    throw new RangeError('fleissKappa: every item must have the same number of votes');
  }

  const categoryTotals = new Map<string, number>();
  let sumP = 0;
  for (const votes of items) {
    let sumSquares = 0;
    for (const [value, count] of tally(votes)) {
      sumSquares += count * count;
      categoryTotals.set(value, (categoryTotals.get(value) ?? 0) + count);
    }
    sumP += (sumSquares - n) / (n * (n - 1));
  }
  const meanP = sumP / N;
  let expected = 0;
  for (const total of categoryTotals.values()) expected += (total / (N * n)) ** 2;
  if (1 - expected < 1e-12) return null;
  return (meanP - expected) / (1 - expected);
}

export interface ResultsSummary {
  unanimousRatio: number | null;
  fleissKappa: number | null;
  kappaItemCount: number;
  labelDistribution: Record<string, number>;
}

/** κ와 만장일치 비율은 투표 수가 정확히 target인 문항만으로 계산한다 (기존 *_iaa.py와 같은 기준). */
export function summarizeResults(items: VotedItem[], target: number): ResultsSummary {
  const full = items.filter((item) => item.votes.length === target);
  const labelDistribution: Record<string, number> = {};
  for (const item of items) {
    for (const value of item.votes) labelDistribution[value] = (labelDistribution[value] ?? 0) + 1;
  }
  return {
    unanimousRatio: full.length === 0 ? null : full.filter((item) => item.unanimous).length / full.length,
    fleissKappa: fleissKappa(full.map((item) => item.votes)),
    kappaItemCount: full.length,
    labelDistribution,
  };
}

/**
 * assignment 1건의 일치율: 각 문항에서 "같은 HIT의 다른 worker들" majority와 같은 비율.
 * 다른 worker의 표가 없거나 동률인 문항은 제외하고, 비교할 문항이 없으면 null이다 (8.5와 같은 방식).
 */
export function agreementWithOthers(
  own: { name: string; value: string }[],
  others: { name: string; value: string }[][],
): number | null {
  const tallies = new Map<string, Map<string, number>>();
  for (const answers of others) {
    for (const a of answers) {
      const counts = tallies.get(a.name) ?? new Map<string, number>();
      counts.set(a.value, (counts.get(a.value) ?? 0) + 1);
      tallies.set(a.name, counts);
    }
  }
  let compared = 0;
  let agreed = 0;
  for (const a of own) {
    const othersMajority = majorityOfTally(tallies.get(a.name) ?? new Map());
    if (othersMajority === null) continue;
    compared += 1;
    if (othersMajority === a.value) agreed += 1;
  }
  return compared === 0 ? null : agreed / compared;
}

// admin 의 API usage 화면이 쓰는 계산. backend(GET /api/admin/usage)는 최근 기록의 줄(rows)을 주고, 날짜별 묶음과
// 오늘·7일·30일 합계는 보는 사람의 현지 날짜로 여기서 계산한다.

const DAY_MS = 24 * 60 * 60 * 1000;

function localDay(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function totalOf(rows) {
  return {
    calls: rows.reduce((sum, row) => sum + (row.calls ?? 0), 0),
    tokens: rows.reduce((sum, row) => sum + (row.tokens ?? 0), 0),
    cost: rows.reduce((sum, row) => sum + (typeof row.cost === 'number' ? row.cost : 0), 0),
    unpriced: rows.filter((row) => typeof row.cost !== 'number').length,
  };
}

/**
 * 최근 줄들의 요약 → { today, last7, last30, byDay: [{ day, calls, tokens, cost, unpriced }] (최근 날짜부터) }.
 * last7 은 오늘을 포함한 7일이다.
 */
export function summarizeUsage(rows, now = new Date()) {
  const today = startOfDay(now).getTime();
  const within = (days) => rows.filter((row) => new Date(row.at).getTime() >= today - (days - 1) * DAY_MS);
  const groups = new Map();
  for (const row of rows) {
    const day = localDay(new Date(row.at));
    if (!groups.has(day)) groups.set(day, []);
    groups.get(day).push(row);
  }
  const byDay = [...groups].map(([day, items]) => ({ day, ...totalOf(items) })).sort((a, b) => (a.day < b.day ? 1 : -1));
  return { today: totalOf(within(1)), last7: totalOf(within(7)), last30: totalOf(within(30)), byDay };
}

/** $0.0123. 아주 작은 값도 0 이 아니면 보이도록 넷째 자리까지, 큰 값은 둘째 자리까지. */
export function formatUsd(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return '—';
  if (value === 0) return '$0';
  if (Math.abs(value) >= 10) return `$${value.toFixed(2)}`;
  if (Math.abs(value) < 0.0001) return '<$0.0001';
  return `$${value.toFixed(4)}`;
}

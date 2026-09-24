// 값을 화면 글자로 바꾸는 도우미. prototype/src/components/format.ts 와 domain/cost.ts 의 formatCents 와 같은 표기를 쓴다.

export const EMPTY = '–';

const pad = (n) => String(n).padStart(2, '0');

/** ISO 8601 → 로컬 시각 "YYYY-MM-DD HH:mm". 값이 없으면 "–". */
export function formatDateTime(iso, withSeconds = false) {
  if (!iso) return EMPTY;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return withSeconds ? `${date} ${time}:${pad(d.getSeconds())}` : `${date} ${time}`;
}

export function formatDate(iso) {
  if (!iso) return EMPTY;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 0.4167 → "42%". 분모가 0이라 값이 없으면 "–". */
export function formatPercent(ratio) {
  return ratio === null || ratio === undefined ? EMPTY : `${Math.round(ratio * 100)}%`;
}

export function formatSeconds(seconds) {
  return seconds === null || seconds === undefined ? EMPTY : `${Math.round(seconds)}s`;
}

/** 센트 단위 금액 → "$57.60". 수수료 때문에 소수 센트가 나올 수 있어 표시할 때 반올림한다. */
export function formatCents(cents) {
  return `$${(Number(cents) / 100).toFixed(2)}`;
}

/** MTurk 식 문자열 금액("0.10") → "$0.10". */
export function formatMoney(text) {
  return text === null || text === undefined || text === '' ? EMPTY : `$${text}`;
}

/** 설정의 초 단위 기간 → "1 day(s)", "1 hour(s)", "20 min" (Overview 와 같은 표기). */
export function formatDurationSeconds(seconds) {
  if (seconds === null || seconds === undefined) return EMPTY;
  if (seconds % 86400 === 0) return `${seconds / 86400} day(s)`;
  if (seconds % 3600 === 0) return `${seconds / 3600} hour(s)`;
  return `${Math.round(seconds / 60)} min`;
}

/** 경과 시간(ms) → "12s", "1m 05s", "1h 02m". */
export function formatElapsed(ms) {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return EMPTY;
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${pad(m)}m`;
  if (m > 0) return `${m}m ${pad(s)}s`;
  return `${s}s`;
}

export function formatNumber(n) {
  return n === null || n === undefined ? EMPTY : Number(n).toLocaleString('en-US');
}

export function formatBytes(bytes) {
  if (bytes === null || bytes === undefined) return EMPTY;
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

/** 소수 → 고정 소수점. κ 같은 통계값에 쓴다. */
export function formatFixed(value, digits = 3) {
  return value === null || value === undefined ? EMPTY : Number(value).toFixed(digits);
}

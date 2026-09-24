import dayjs from 'dayjs';

export const EMPTY = '–';

export function formatDateTime(iso: string | null | undefined, withSeconds = false): string {
  if (!iso) return EMPTY;
  return dayjs(iso).format(withSeconds ? 'YYYY-MM-DD HH:mm:ss' : 'YYYY-MM-DD HH:mm');
}

export function formatDate(iso: string | null | undefined): string {
  return iso ? dayjs(iso).format('YYYY-MM-DD') : EMPTY;
}

/** 0.4167 → "42%". 분모가 0이라 값이 없으면 "–". */
export function formatPercent(ratio: number | null | undefined): string {
  return ratio === null || ratio === undefined ? EMPTY : `${Math.round(ratio * 100)}%`;
}

export function formatSeconds(seconds: number | null | undefined): string {
  return seconds === null || seconds === undefined ? EMPTY : `${Math.round(seconds)}s`;
}

export function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

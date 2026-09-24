import { formatCents } from '../domain/cost';

/** 센트 단위 금액을 "$57.60"으로 표시한다. 표에서 자릿수가 맞게 고정폭 숫자를 쓴다. */
export default function MoneyText({ cents }: { cents: number }) {
  return <span style={{ fontVariantNumeric: 'tabular-nums' }}>{formatCents(cents)}</span>;
}

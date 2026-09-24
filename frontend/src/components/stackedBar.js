// 구성비를 보여 주는 가로 누적 막대 (Overview 의 assignment 상태, Results 의 라벨 분포).
// 색만으로 구분하지 않도록 범례에 이름과 값을 항상 함께 쓴다. 범례의 숫자가 곧 표 보기다.

import { el } from './dom.js';

// 상태색은 상태에만 쓴다 (좋음 / 주의 / 위험 / 해당 없음)
export const STATUS_COLORS = { good: '#0ca30c', warning: '#fab219', critical: '#d03b3b', neutral: '#c9c8c2' };
// 범주색은 정해진 순서대로만 쓴다. 9번째부터는 회색이다.
export const CATEGORY_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];

/** segments: [{ key, label, value, color }] */
export function stackedBar(segments, height = 14) {
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  const visible = segments.filter((s) => s.value > 0);
  const percent = (value) => (total === 0 ? '0%' : `${((value / total) * 100).toFixed(value / total < 0.1 ? 1 : 0)}%`);

  const bar = el('div', { className: `bar${total === 0 ? ' bar-empty' : ''}`, style: { height: `${height}px` } });
  for (const s of visible) {
    bar.append(
      el('div', {
        className: 'bar-segment',
        title: `${s.label}: ${s.value.toLocaleString('en-US')} (${percent(s.value)})`,
        style: { flex: `${s.value} 0 0`, background: s.color },
      }),
    );
  }
  const legend = el(
    'div',
    { className: 'bar-legend' },
    segments.map((s) =>
      el(
        'span',
        { className: 'bar-legend-item', dataset: { key: s.key } },
        el('span', { className: 'bar-swatch', style: { background: s.color } }),
        el('span', { className: 'muted' }, s.label),
        el('strong', { className: 'tabular' }, s.value.toLocaleString('en-US')),
        el('span', { className: 'muted small' }, percent(s.value)),
      ),
    ),
  );
  return el('div', { className: 'stacked-bar' }, bar, legend);
}

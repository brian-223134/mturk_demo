// 구성비를 보여주는 가로 누적 막대 (Overview의 assignment 상태, Results의 라벨 분포).
// 막대 사이는 2px 띄우고 끝만 둥글게 한다. 색만으로 구분하지 않도록 범례에 이름과 값을 항상 함께 쓰고,
// 글자에는 시리즈 색을 쓰지 않는다. 범례의 숫자가 곧 표 보기다.

import { Flex, Tooltip, Typography } from 'antd';

export interface BarSegment {
  key: string;
  label: string;
  value: number;
  color: string;
}

// 상태색은 상태에만 쓴다 (좋음 / 주의 / 위험 / 해당 없음)
export const STATUS_COLORS = { good: '#0ca30c', warning: '#fab219', critical: '#d03b3b', neutral: '#c9c8c2' };
// 범주색은 정해진 순서대로만 쓴다. 9번째부터는 "Other"로 묶는다.
export const CATEGORY_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];

const RADIUS = 4;

export default function StackedBar({ segments, height = 14 }: { segments: BarSegment[]; height?: number }) {
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  const visible = segments.filter((s) => s.value > 0);
  const percent = (value: number) => (total === 0 ? '0%' : `${((value / total) * 100).toFixed(value / total < 0.1 ? 1 : 0)}%`);

  return (
    <div>
      <Flex gap={2} style={{ height, borderRadius: RADIUS, overflow: 'hidden', background: total === 0 ? '#f0efec' : undefined }}>
        {visible.map((s, i) => (
          <Tooltip key={s.key} title={`${s.label}: ${s.value.toLocaleString()} (${percent(s.value)})`}>
            <div
              style={{
                flex: `${s.value} 0 0`,
                minWidth: 3,
                background: s.color,
                borderRadius: `${i === 0 ? RADIUS : 0}px ${i === visible.length - 1 ? RADIUS : 0}px ${i === visible.length - 1 ? RADIUS : 0}px ${i === 0 ? RADIUS : 0}px`,
              }}
            />
          </Tooltip>
        ))}
      </Flex>
      <Flex gap={20} wrap style={{ marginTop: 8 }}>
        {segments.map((s) => (
          <Flex key={s.key} gap={6} align="center">
            <span style={{ width: 10, height: 10, borderRadius: 2, background: s.color, display: 'inline-block' }} />
            <Typography.Text type="secondary" style={{ fontSize: 13 }}>
              {s.label}
            </Typography.Text>
            <Typography.Text strong style={{ fontSize: 13, fontVariantNumeric: 'tabular-nums' }}>
              {s.value.toLocaleString()}
            </Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {percent(s.value)}
            </Typography.Text>
          </Flex>
        ))}
      </Flex>
    </div>
  );
}

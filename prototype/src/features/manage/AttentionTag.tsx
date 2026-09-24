import { Tag, Typography } from 'antd';
import type { AttentionResult } from '../../api/types';

/** 8.2의 판정 결과. 색만으로 구분하지 않도록 PASS/FAIL을 글자로도 쓴다. */
export default function AttentionTag({ attention }: { attention: AttentionResult | null }) {
  if (!attention) return <Typography.Text type="secondary">n/a</Typography.Text>;
  return (
    <Tag color={attention.passed ? 'green' : 'red'} style={{ marginInlineEnd: 0 }}>
      {attention.correct}/{attention.total} {attention.passed ? 'PASS' : 'FAIL'}
    </Tag>
  );
}

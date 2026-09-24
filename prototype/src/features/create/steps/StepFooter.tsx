import { Button, Flex, Space, Typography } from 'antd';
import type { ReactNode } from 'react';

interface Props {
  onBack?: () => void;
  onNext: () => void;
  nextLabel?: string;
  nextDisabled?: boolean;
  nextLoading?: boolean;
  /** Next가 막혀 있는 이유처럼, 버튼 옆에 짧게 알릴 것 */
  hint?: ReactNode;
}

/** 모든 단계의 아래쪽 Back / Next 줄 */
export default function StepFooter({ onBack, onNext, nextLabel = 'Next', nextDisabled, nextLoading, hint }: Props) {
  return (
    <Flex justify="flex-end" align="center" gap={16} style={{ marginTop: 24 }}>
      {hint && <Typography.Text type="secondary">{hint}</Typography.Text>}
      <Space>
        {onBack && (
          <Button onClick={onBack} disabled={nextLoading}>
            Back
          </Button>
        )}
        <Button type="primary" onClick={onNext} disabled={nextDisabled} loading={nextLoading}>
          {nextLabel}
        </Button>
      </Space>
    </Flex>
  );
}

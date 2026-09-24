import { Empty, Typography } from 'antd';

/** 아직 구현하지 않은 화면의 자리. 설계 명세 10장의 어느 단계에서 채워지는지 보여준다. */
export default function ComingSoon({ milestone, children }: { milestone: string; children: string }) {
  return (
    <Empty
      image={Empty.PRESENTED_IMAGE_SIMPLE}
      style={{ padding: '48px 0' }}
      description={
        <>
          <Typography.Text strong>Planned for {milestone}</Typography.Text>
          <br />
          <Typography.Text type="secondary">{children}</Typography.Text>
        </>
      }
    />
  );
}

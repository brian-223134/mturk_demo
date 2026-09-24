// 5.4 Worker Pool 탭의 틀: [Workers] [Pools] 전환

import { Flex, Segmented, Typography } from 'antd';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';

export default function WorkersLayout() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const view = pathname.startsWith('/workers/pools') ? 'pools' : 'workers';

  return (
    <>
      <Flex justify="space-between" align="center" style={{ marginBottom: 16 }}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          Worker Pool
        </Typography.Title>
        <Segmented
          value={view}
          onChange={(next) => navigate(next === 'pools' ? '/workers/pools' : '/workers')}
          options={[
            { label: 'Workers', value: 'workers' },
            { label: 'Pools', value: 'pools' },
          ]}
        />
      </Flex>
      <Outlet />
    </>
  );
}

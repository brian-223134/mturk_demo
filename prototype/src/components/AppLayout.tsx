// 5.1 공통 레이아웃: 제목 줄(환경 배지, 잔액, Mock tools)과 세 탭

import { useQuery } from '@tanstack/react-query';
import { Layout, Menu, Space, Typography } from 'antd';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { api } from '../api/client';
import EnvBadge from './EnvBadge';
import MockToolsMenu from './MockToolsMenu';

const TABS = [
  { key: 'create', label: <Link to="/create">Create</Link> },
  { key: 'manage', label: <Link to="/manage">Manage</Link> },
  { key: 'workers', label: <Link to="/workers">Worker Pool</Link> },
];

export default function AppLayout() {
  const { pathname } = useLocation();
  const activeTab = pathname.split('/')[1] ?? '';
  const account = useQuery({ queryKey: ['account'], queryFn: () => api.getAccount() });

  return (
    <Layout style={{ minHeight: '100vh', minWidth: 1280 }}>
      <Layout.Header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          height: 48,
          lineHeight: '48px',
          paddingInline: 24,
        }}
      >
        <Typography.Text strong style={{ color: '#fff', fontSize: 16 }}>
          MTurk Console
        </Typography.Text>
        <Space size="middle">
          {account.data && <EnvBadge env={account.data.env} />}
          <Typography.Text style={{ color: 'rgba(255, 255, 255, 0.85)' }}>
            Balance {account.data ? `$${account.data.AvailableBalance}` : '…'}
          </Typography.Text>
          {account.data?.env === 'mock' && <MockToolsMenu />}
        </Space>
      </Layout.Header>
      <Menu mode="horizontal" selectedKeys={[activeTab]} items={TABS} style={{ paddingInline: 8 }} />
      <Layout.Content style={{ padding: 24 }}>
        <Outlet />
      </Layout.Content>
    </Layout>
  );
}

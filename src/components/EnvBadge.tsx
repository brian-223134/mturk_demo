import { Tag } from 'antd';
import type { Env } from '../api/types';

// 5.1: MOCK(회색), SANDBOX(파랑), PRODUCTION(빨강)
const COLORS: Record<Env, string> = {
  mock: 'default',
  sandbox: 'blue',
  production: 'red',
};

export default function EnvBadge({ env }: { env: Env }) {
  return (
    <Tag color={COLORS[env]} style={{ marginInlineEnd: 0, fontWeight: 600 }}>
      {env.toUpperCase()}
    </Tag>
  );
}

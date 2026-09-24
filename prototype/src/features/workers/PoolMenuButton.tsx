// 5.4 도구줄의 [Add to pool ▾] [Remove from pool ▾]. worker 목록과 worker 상세가 함께 쓴다.

import { DownOutlined } from '@ant-design/icons';
import { Button, Dropdown, Typography, type MenuProps } from 'antd';
import { useState } from 'react';
import type { WorkerPool } from '../../api/types';

interface Props {
  mode: 'add' | 'remove';
  pools: WorkerPool[] | undefined;
  workerIds: string[];
  /** 다른 변경이 진행 중일 때 */
  disabled?: boolean;
  /** 끝날 때까지 이 버튼에 진행 표시를 한다 */
  onPick: (pool: WorkerPool) => Promise<unknown>;
}

export default function PoolMenuButton({ mode, pools = [], workerIds, disabled, onPick }: Props) {
  const [pending, setPending] = useState(false);
  const total = workerIds.length;
  // 소속은 worker.poolIds가 아니라 pool의 workerIds로 센다. 다른 페이지에서 고른 worker도 정확히 세기 위해서다.
  const counted = pools.map((pool) => ({
    pool,
    inPool: workerIds.filter((id) => pool.workerIds.includes(id)).length,
  }));
  const hint = (text: string) => (
    <Typography.Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>
      {text}
    </Typography.Text>
  );

  let items: NonNullable<MenuProps['items']>;
  if (mode === 'add') {
    items = counted.map(({ pool, inPool }) => ({
      key: pool.id,
      disabled: inPool === total,
      label: (
        <>
          {pool.name}
          {inPool > 0 && hint(total === 1 ? 'already a member' : `${inPool} of ${total} already in`)}
        </>
      ),
    }));
    if (items.length === 0) items = [{ key: 'none', disabled: true, label: 'No pools yet. Create one under Pools.' }];
  } else {
    items = counted
      .filter(({ inPool }) => inPool > 0)
      .map(({ pool, inPool }) => ({
        key: pool.id,
        label: (
          <>
            {pool.name}
            {total > 1 && hint(`${inPool} of ${total} selected`)}
          </>
        ),
      }));
    if (items.length === 0) {
      items = [{ key: 'none', disabled: true, label: total === 1 ? 'Not in any pool' : 'None of the selected workers is in a pool' }];
    }
  }

  const onClick: MenuProps['onClick'] = ({ key }) => {
    const pool = pools.find((p) => p.id === key);
    if (!pool) return;
    setPending(true);
    void onPick(pool).finally(() => setPending(false));
  };

  return (
    <Dropdown trigger={['click']} disabled={(disabled && !pending) || total === 0} menu={{ items, onClick }}>
      <Button loading={pending}>
        {mode === 'add' ? 'Add to pool' : 'Remove from pool'} <DownOutlined />
      </Button>
    </Dropdown>
  );
}

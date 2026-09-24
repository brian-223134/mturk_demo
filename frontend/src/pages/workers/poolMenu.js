// 도구줄의 [Add to pool ▾] [Remove from pool ▾]. worker 목록과 worker 상세가 함께 쓴다.
//   poolMenuButton({ mode: 'add'|'remove', pools, workerIds, disabled, onPick(pool) })

import { menuButton } from '../../components/menu.js';

export function poolMenuButton({ mode, pools = [], workerIds, disabled = false, onPick }) {
  const total = workerIds.length;
  // 소속은 worker.poolIds 가 아니라 pool 의 workerIds 로 센다. 다른 페이지에서 고른 worker 도 정확히 세기 위해서다.
  const counted = pools.map((pool) => ({ pool, inPool: workerIds.filter((id) => pool.workerIds.includes(id)).length }));
  let items;
  if (mode === 'add') {
    items = counted.map(({ pool, inPool }) => ({
      key: pool.id,
      label: pool.name,
      disabled: inPool === total,
      hint: inPool > 0 ? (total === 1 ? 'already a member' : `${inPool} of ${total} already in`) : null,
      onClick: () => onPick(pool),
    }));
    if (items.length === 0) items = [{ key: 'none', disabled: true, label: 'No pools yet. Create one under Pools.' }];
  } else {
    items = counted
      .filter(({ inPool }) => inPool > 0)
      .map(({ pool, inPool }) => ({ key: pool.id, label: pool.name, hint: total > 1 ? `${inPool} of ${total} selected` : null, onClick: () => onPick(pool) }));
    if (items.length === 0) {
      items = [{ key: 'none', disabled: true, label: total === 1 ? 'Not in any pool' : 'None of the selected workers is in a pool' }];
    }
  }
  return menuButton({ label: mode === 'add' ? 'Add to pool' : 'Remove from pool', items, disabled: disabled || total === 0, dataset: { menu: `pool-${mode}` } });
}

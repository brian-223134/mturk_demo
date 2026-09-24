// Worker Pool 화면들이 함께 쓰는 것: 제외용 pool 의 id, 문구, pool 추가/제거와 차단/해제 (같은 문구와 알림을 쓰도록 한곳에 둔다).

import { api } from '../../api-client/client.js';
import { el } from '../../components/dom.js';
import { toast } from '../../components/toast.js';

/** 차단 대신 쓰는 제외용 pool. fixture 에 들어 있고, 없으면 화면이 pool 을 직접 고르게 한다. */
export const EXCLUDED_POOL_ID = 'pool-excluded';

/** listWorkers 의 pageSize 상한 */
export const MAX_PAGE = 1000;

export function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

export function countWorkers(count) {
  return `${count} worker${count === 1 ? '' : 's'}`;
}

export function workerPath(workerId) {
  return `/workers/${encodeURIComponent(workerId)}`;
}

/** Manage 의 Review 탭이 `worker` query param 을 읽어 이 worker 의 assignment 만 보여준다. */
export function reviewLink(batchId, workerId) {
  return `/manage/${encodeURIComponent(batchId)}/review?worker=${encodeURIComponent(workerId)}`;
}

/** 성공하면 true. 실패는 여기서 알리므로 부른 쪽은 선택 해제 같은 뒷정리만 하면 된다. */
async function run(failTitle, action) {
  try {
    const outcome = await action();
    toast[outcome.kind](outcome.text);
    return true;
  } catch (error) {
    toast.error(failTitle, errorText(error));
    return false;
  }
}

// 이미 들어 있는 worker 는 API 가 조용히 넘기므로, 실제로 몇 명이 바뀌었는지는 호출 전 인원으로 센다
export const workerActions = {
  addToPool: (pool, workerIds) =>
    run(`Could not add to "${pool.name}"`, async () => {
      const already = workerIds.filter((id) => pool.workerIds.includes(id)).length;
      await api.addWorkersToPool(pool.id, workerIds);
      const added = workerIds.length - already;
      if (added === 0) return { kind: 'info', text: `Nothing to add: already in "${pool.name}".` };
      return { kind: 'success', text: `Added ${countWorkers(added)} to "${pool.name}".${already > 0 ? ` ${already} already in it.` : ''}` };
    }),
  removeFromPool: (pool, workerIds) =>
    run(`Could not remove from "${pool.name}"`, async () => {
      const members = workerIds.filter((id) => pool.workerIds.includes(id)).length;
      await api.removeWorkersFromPool(pool.id, workerIds);
      return { kind: 'success', text: `Removed ${countWorkers(members)} from "${pool.name}".` };
    }),
  block: (workerIds, reason) =>
    run('Block failed', async () => {
      await api.blockWorkers(workerIds, reason);
      return { kind: 'success', text: `Blocked ${countWorkers(workerIds.length)}.` };
    }),
  unblock: (workerIds) =>
    run('Unblock failed', async () => {
      await api.unblockWorkers(workerIds);
      return { kind: 'success', text: `Unblocked ${countWorkers(workerIds.length)}.` };
    }),
};

/** Worker Pool 의 제목 줄과 [Workers] [Pools] 전환. view: 'workers' | 'pools' | 'detail' */
export function workersHeader(view) {
  return el(
    'div',
    { className: 'page-header page-header-split' },
    el('h2', { className: 'page-title' }, 'Worker Pool'),
    el(
      'div',
      { className: 'segmented', role: 'tablist', id: 'workers-view' },
      el('a', { href: '/workers', className: `segment${view === 'workers' ? ' active' : ''}`, role: 'tab', dataset: { view: 'workers' }, 'aria-selected': view === 'workers' ? 'true' : 'false' }, 'Workers'),
      el('a', { href: '/workers/pools', className: `segment${view === 'pools' ? ' active' : ''}`, role: 'tab', dataset: { view: 'pools' }, 'aria-selected': view === 'pools' ? 'true' : 'false' }, 'Pools'),
    ),
  );
}

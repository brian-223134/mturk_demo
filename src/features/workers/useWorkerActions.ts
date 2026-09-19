// pool 추가/제거와 차단/해제. 목록, pool, 상세 화면이 같은 문구와 같은 무효화를 쓰도록 한곳에 둔다.

import { useQueryClient } from '@tanstack/react-query';
import { App } from 'antd';
import { useState } from 'react';
import { api } from '../../api/client';
import type { WorkerPool } from '../../api/types';
import { countWorkers, errorText, invalidateWorkerData } from './shared';

interface Outcome {
  kind: 'success' | 'info';
  text: string;
}

export function useWorkerActions() {
  const queryClient = useQueryClient();
  const { message, notification } = App.useApp();
  const [busy, setBusy] = useState(false);

  /** 성공하면 true. 실패는 여기서 알리므로 부른 쪽은 선택 해제 같은 뒷정리만 하면 된다. */
  async function run(failTitle: string, action: () => Promise<Outcome>): Promise<boolean> {
    setBusy(true);
    try {
      const outcome = await action();
      await invalidateWorkerData(queryClient);
      message[outcome.kind](outcome.text);
      return true;
    } catch (error) {
      notification.error({ message: failTitle, description: errorText(error) });
      return false;
    } finally {
      setBusy(false);
    }
  }

  // 이미 들어 있는 worker는 API가 조용히 넘기므로, 실제로 몇 명이 바뀌었는지는 호출 전 인원으로 센다
  const addToPool = (pool: WorkerPool, workerIds: string[]) =>
    run(`Could not add to "${pool.name}"`, async () => {
      const already = workerIds.filter((id) => pool.workerIds.includes(id)).length;
      await api.addWorkersToPool(pool.id, workerIds);
      const added = workerIds.length - already;
      if (added === 0) return { kind: 'info', text: `Nothing to add: already in "${pool.name}".` };
      return {
        kind: 'success',
        text: `Added ${countWorkers(added)} to "${pool.name}".${already > 0 ? ` ${already} already in it.` : ''}`,
      };
    });

  const removeFromPool = (pool: WorkerPool, workerIds: string[]) =>
    run(`Could not remove from "${pool.name}"`, async () => {
      const members = workerIds.filter((id) => pool.workerIds.includes(id)).length;
      await api.removeWorkersFromPool(pool.id, workerIds);
      return { kind: 'success', text: `Removed ${countWorkers(members)} from "${pool.name}".` };
    });

  const block = (workerIds: string[], reason: string) =>
    run('Block failed', async () => {
      await api.blockWorkers(workerIds, reason);
      return { kind: 'success', text: `Blocked ${countWorkers(workerIds.length)}.` };
    });

  const unblock = (workerIds: string[]) =>
    run('Unblock failed', async () => {
      await api.unblockWorkers(workerIds);
      return { kind: 'success', text: `Unblocked ${countWorkers(workerIds.length)}.` };
    });

  return { busy, addToPool, removeFromPool, block, unblock };
}

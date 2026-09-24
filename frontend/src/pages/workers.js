// Worker Pool. 세 화면을 경로로 나눈다: /workers (worker 목록), /workers/pools (pool 목록), /workers/:workerId (worker 상세).
// 제목 줄의 [Workers] [Pools] 로 목록과 pool 을 오간다. 화면의 내용은 pages/workers/*.js 에 있다.

import { closeAllOverlays } from '../components/overlay.js';
import { renderWorkerDetail } from './workers/detail.js';
import { renderWorkerList } from './workers/list.js';
import { renderPools as renderPoolList } from './workers/pools.js';
import { workersHeader } from './workers/shared.js';

export async function render(root, _params, signal) {
  root.append(workersHeader('workers'));
  await renderWorkerList(root, signal);
  return () => closeAllOverlays();
}

export async function renderPools(root, _params, signal) {
  root.append(workersHeader('pools'));
  await renderPoolList(root, signal);
  return () => closeAllOverlays();
}

export async function renderDetail(root, params, signal) {
  await renderWorkerDetail(root, params.workerId, signal);
  return () => closeAllOverlays();
}

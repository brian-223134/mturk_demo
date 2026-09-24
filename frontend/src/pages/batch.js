// Manage › batch 상세. getBatch 로 받은 BatchDetail 로 제목 줄(이름, 상태, Needs review)과 네 탭을 그린다.
// 탭은 경로(/manage/:batchId/:tab)로 정하므로 새로고침해도 같은 탭이 열린다. 탭의 내용은 pages/manage/*Tab.js 에 있다.
// 검수, 재모집, 만료는 진행률과 상태를 바꾸므로 탭이 ctx.refreshDetail() 로 제목 줄과 탭 이름을 다시 맞춘다.

import { api } from '../api-client/client.js';
import { needsReviewTag, statusTag } from '../components/badges.js';
import { el } from '../components/dom.js';
import { errorNotice, loading } from '../components/notice.js';
import { closeAllOverlays } from '../components/overlay.js';
import { replace } from '../components/render.js';
import { navigate } from '../router.js';
import { renderHits } from './manage/hitsTab.js';
import { renderOverview } from './manage/overviewTab.js';
import { renderResults } from './manage/resultsTab.js';
import { renderReview } from './manage/reviewTab.js';
import { batchPath } from './manage/shared.js';

const TABS = ['overview', 'review', 'hits', 'results'];

export async function render(root, params, signal) {
  const batchId = params.batchId;
  if (params.tab !== undefined && !TABS.includes(params.tab)) {
    navigate(batchPath(batchId, 'overview'), { replace: true });
    return;
  }
  const tab = params.tab ?? 'overview';

  const title = el('span', { className: 'crumb-current', id: 'batch-name' }, batchId);
  const badges = el('span', { className: 'page-badges', id: 'batch-badges' });
  const header = el(
    'div',
    { className: 'page-header' },
    el('nav', { className: 'crumbs', 'aria-label': 'Breadcrumb' }, el('a', { href: '/manage' }, 'Manage'), el('span', { className: 'crumb-sep' }, '›'), title),
    badges,
  );
  const body = el('div', { id: 'batch-body' }, loading());
  root.append(header, body);

  let detail;
  try {
    detail = await api.getBatch(batchId);
  } catch (error) {
    if (signal.aborted) return;
    replace(body, errorNotice(error, 'Batch'));
    return;
  }
  if (signal.aborted) return;

  const tabBar = el('div', { className: 'tabs', role: 'tablist' });
  const panel = el('div', { className: 'tab-panel', id: `tab-${tab}`, dataset: { tab } });
  replace(body, tabBar, panel);

  function paintHeader() {
    title.textContent = detail.batch.name;
    replace(badges, statusTag(detail.status), detail.needsReview ? needsReviewTag(detail.progress.submitted) : null);
    const submitted = detail.progress.submitted;
    const labels = { overview: 'Overview', review: submitted > 0 ? `Review (${submitted})` : 'Review', hits: 'HITs', results: 'Results' };
    replace(tabBar, 
      TABS.map((key) =>
        el(
          'a',
          { href: batchPath(batchId, key), className: `tab${key === tab ? ' active' : ''}`, role: 'tab', dataset: { tab: key }, 'aria-selected': key === tab ? 'true' : 'false' },
          labels[key],
        ),
      ),
    );
  }
  paintHeader();

  const ctx = {
    get detail() {
      return detail;
    },
    signal,
    /** 변경 뒤 BatchDetail 을 다시 받아 제목 줄을 맞춘다. 실패하면 이전 값을 그대로 둔다. */
    async refreshDetail() {
      try {
        const next = await api.getBatch(batchId);
        if (signal.aborted) return detail;
        detail = next;
        paintHeader();
      } catch (error) {
        if (!signal.aborted) console.error(error);
      }
      return detail;
    },
  };

  if (tab === 'overview') renderOverview(panel, ctx);
  else if (tab === 'hits') await renderHits(panel, ctx);
  else if (tab === 'review') await renderReview(panel, ctx);
  else await renderResults(panel, ctx);

  // 다른 곳으로 이동하면 열려 있던 모달과 drawer 를 닫는다
  return () => closeAllOverlays();
}

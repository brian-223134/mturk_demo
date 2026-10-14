// worker 계정의 첫 화면(/worker). 지금은 계정 정보와 Worker ID 만 보여 준다.
// HIT 목록, 작업 화면, 제출 기록은 다음 단계에서 이 화면 아래에 붙는다.

import { el } from '../components/dom.js';
import { notice } from '../components/notice.js';

export function renderHome(container, _params, _signal, session) {
  const user = session.user;
  container.append(
    el('div', { className: 'page-title' }, el('h2', {}, `Welcome, ${user.displayName}`)),
    el(
      'section',
      { className: 'panel' },
      el('h3', { className: 'panel-title' }, 'Your Worker ID'),
      el('p', { className: 'worker-id' }, el('code', { dataset: { workerId: user.workerId ?? '' } }, user.workerId ?? '–')),
      el('p', { className: 'muted' }, 'Requesters see only this ID with your answers. Your email and name are not shown to them.'),
    ),
    el(
      'section',
      { className: 'panel' },
      el('h3', { className: 'panel-title' }, 'HITs'),
      notice('info', 'No HITs to show yet', 'Your account is ready. Taking HITs from this page is not available yet; the lab will let you know when tasks open.'),
    ),
  );
}

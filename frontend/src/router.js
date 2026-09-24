// history API 라우터. 경로 패턴(/manage/:batchId)을 페이지 모듈의 render(container, params, signal) 에 잇는다.
// 같은 origin 의 <a href="/…"> 클릭은 가로채 pushState 로 처리하고, 뒤로/앞으로(popstate)도 같은 dispatch 를 탄다.
// 페이지가 fetch 를 기다리는 동안 다른 곳으로 이동하면 signal 이 abort 되므로, 페이지는 await 뒤에 signal.aborted 를 확인한다.
// render 가 함수를 돌려주면 다음 이동 때 그 함수를 불러 준다 (폴링 타이머 정리 등).
// 패턴 컴파일과 매칭은 router-match.js 에 있다 (DOM 없이 테스트할 수 있도록 분리).

import { el } from './components/dom.js';
import { errorNotice } from './components/notice.js';
import { compilePattern, matchRoute } from './router-match.js';

const routes = [];
let container = null;
let onNavigate = () => {};
let current = { abort: null, cleanup: null };

/** route('/manage/:batchId', module.render, { tab: 'manage' }) 또는 route('/', null, { redirect: '/create' }) */
export function route(pattern, handler, meta = {}) {
  routes.push({ ...compilePattern(pattern), handler, meta });
}

export function configure(options) {
  container = options.container;
  onNavigate = options.onNavigate ?? onNavigate;
}

export function navigate(path, { replace = false } = {}) {
  if (replace) history.replaceState(null, '', path);
  else history.pushState(null, '', path);
  void dispatch();
}

function notFound(pathname) {
  return el(
    'div',
    {},
    el('h2', { className: 'page-title' }, 'Page not found'),
    el('p', { className: 'muted' }, `No such page: ${pathname}`),
    el('p', {}, el('a', { href: '/manage' }, 'Go to Manage')),
  );
}

async function dispatch() {
  const pathname = location.pathname;
  const found = matchRoute(routes, pathname);
  if (found?.meta.redirect) {
    navigate(found.meta.redirect, { replace: true });
    return;
  }

  // 이전 페이지를 정리한다: 진행 중이던 fetch 결과는 버리고, 타이머 등은 cleanup 으로 멈춘다
  if (current.abort) current.abort.abort();
  if (typeof current.cleanup === 'function') current.cleanup();
  const abort = new AbortController();
  current = { abort, cleanup: null };

  container.replaceChildren();
  window.scrollTo(0, 0);
  onNavigate(found?.meta.tab ?? null, found?.params ?? {});

  if (!found) {
    container.append(notFound(pathname));
    return;
  }
  try {
    const cleanup = await found.handler(container, found.params, abort.signal);
    if (abort.signal.aborted) {
      if (typeof cleanup === 'function') cleanup();
      return;
    }
    current.cleanup = cleanup;
  } catch (error) {
    if (abort.signal.aborted) return;
    console.error(error);
    container.append(errorNotice(error, 'Page'));
  }
}

function onClick(event) {
  if (event.defaultPrevented || event.button !== 0) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const anchor = event.target.closest('a[href]');
  if (!anchor) return;
  if (anchor.target && anchor.target !== '_self') return;
  if (anchor.hasAttribute('download') || anchor.dataset.external !== undefined) return;
  const url = new URL(anchor.href, location.href);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/')) return; // 파일 내려받기 등은 브라우저에 맡긴다
  event.preventDefault();
  if (url.pathname + url.search === location.pathname + location.search) {
    void dispatch(); // 같은 곳을 다시 누르면 새로 그린다
    return;
  }
  navigate(url.pathname + url.search + url.hash);
}

export function start() {
  window.addEventListener('popstate', () => void dispatch());
  document.addEventListener('click', onClick);
  void dispatch();
}

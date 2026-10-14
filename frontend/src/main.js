// 시작점: 로그인 상태(GET /api/auth/me)를 보고 역할에 맞는 레이아웃과 경로를 등록한다.
//   로그인 안 함  /login, /signup. 다른 경로는 /login?next=… 로 보낸다
//   worker       /worker(HITs), /worker/assignments/:assignmentId(작업 화면), /worker/history(Your HITs). 다른 경로는 /worker 로
//   requester    콘솔 (Create, Manage, Worker Pool). admin 은 Users(/admin/users)도
// 계정 API 가 없는 서버(prototype 의 mock API, API_UPSTREAM)에 붙었으면 예전처럼 로그인 없이 콘솔을 그린다.
// 콘솔이나 agent API 가 401 을 돌려주면(세션이 끝남) 페이지를 새로 불러 로그인 화면으로 보낸다.

import { AUTH_REQUIRED_EVENT, auth, isApiError } from './api-client/client.js';
import { el } from './components/dom.js';
import { createAuthLayout, createLayout, createWorkerLayout } from './components/layout.js';
import { errorNotice } from './components/notice.js';
import { homePath, loginPath } from './lib/session.js';
import * as adminPages from './pages/admin.js';
import * as authPages from './pages/auth.js';
import * as batch from './pages/batch.js';
import * as create from './pages/create.js';
import * as manage from './pages/manage.js';
import * as workerPages from './pages/worker.js';
import * as workers from './pages/workers.js';
import { configure, navigate, route, start } from './router.js';

const root = document.getElementById('app');

/** { user } (로그인함), { user: null } (로그인 안 함), { user: null, authDisabled: true } (계정 API 가 없는 서버). */
async function loadSession() {
  try {
    return await auth.me();
  } catch (error) {
    if (isApiError(error, 'UNAUTHORIZED')) return { user: null };
    if (isApiError(error, 'NOT_FOUND')) return { user: null, authDisabled: true };
    throw error;
  }
}

/** 페이지 함수에 session 을 넷째 인자로 넘긴다. */
const withSession = (session, render) => (container, params, signal) => render(container, params, signal, session);

function startPublic() {
  const layout = createAuthLayout(root);
  configure({
    container: layout.content,
    onNavigate: layout.setActive,
    onNotFound: (pathname, search) => navigate(loginPath(pathname + search), { replace: true }),
  });
  route('/', null, { redirect: '/login' });
  route('/login', authPages.renderLogin);
  route('/signup', authPages.renderSignup);
}

function startWorker(session) {
  const layout = createWorkerLayout(root, session);
  configure({ container: layout.content, onNavigate: layout.setActive, onNotFound: () => navigate('/worker', { replace: true }) });
  route('/worker', withSession(session, workerPages.renderHits), { tab: 'worker-home' });
  route('/worker/history', withSession(session, workerPages.renderHistory), { tab: 'worker-history' });
  route('/worker/assignments/:assignmentId', withSession(session, workerPages.renderTask), { tab: 'worker-home' });
}

function startConsole(session) {
  const layout = createLayout(root, session.user ? session : null);
  configure({ container: layout.content, onNavigate: (tab) => layout.setActive(tab) });

  route('/', null, { redirect: '/create' });
  route('/index.html', null, { redirect: '/create' });
  route('/login', null, { redirect: '/create' });
  route('/signup', null, { redirect: '/create' });
  route('/worker', null, { redirect: '/create' });
  route('/create', create.render, { tab: 'create' });
  route('/create/new', create.renderNew, { tab: 'create' });
  route('/create/tutorial', create.renderGuide, { tab: 'create' });
  route('/create/project/:projectId', create.renderProject, { tab: 'create' });
  route('/create/project/:projectId/:tab', create.renderProject, { tab: 'create' });
  route('/create/publish/:projectId', create.renderPublish, { tab: 'create' });
  route('/manage', manage.render, { tab: 'manage' });
  route('/manage/:batchId', batch.render, { tab: 'manage' });
  route('/manage/:batchId/:tab', batch.render, { tab: 'manage' });
  route('/workers', workers.render, { tab: 'workers' });
  route('/workers/pools', workers.renderPools, { tab: 'workers' }); // :workerId 보다 먼저 (등록 순서대로 맞춘다)
  route('/workers/:workerId', workers.renderDetail, { tab: 'workers' });
  if (session.user?.role === 'admin') route('/admin/users', withSession(session, adminPages.renderUsers), { tab: 'users' });
}

async function boot() {
  let session;
  try {
    session = await loadSession();
  } catch (error) {
    root.replaceChildren(
      el('main', { className: 'content' }, errorNotice(error, 'Sign-in check'), el('button', { type: 'button', className: 'btn', onClick: () => location.reload() }, 'Retry')),
    );
    return;
  }
  if (!session.user && !session.authDisabled) {
    startPublic();
  } else {
    if (session.user) {
      window.addEventListener(AUTH_REQUIRED_EVENT, () => location.assign(loginPath(location.pathname + location.search)), { once: true });
    }
    if (session.user?.role === 'worker') startWorker(session);
    else startConsole(session);
    if (session.user && (location.pathname === '/login' || location.pathname === '/signup')) {
      history.replaceState(null, '', homePath(session.user.role));
    }
  }
  start();
}

void boot();

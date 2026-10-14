// 레이아웃 세 가지.
//   createLayout        Requester 콘솔: 제목 줄(환경 배지, 잔액, 계정 메뉴), 탭(Create, Manage, Worker Pool, admin 이면 Users), 오류 띠, 내용 영역
//   createWorkerLayout  worker 화면: 제목 줄(Worker ID, 계정 메뉴), 탭, 내용 영역
//   createAuthLayout    로그인 전(로그인, 가입): 내용 영역만
// 환경 배지와 잔액은 getAccount 로 채운다. 실패하면(backend 가 내려가 있음) 오류 띠에 안내를 보여 주고 화면은 계속 뜬다.
// session 이 null 이면(backend 에 계정 API 가 없는 prototype 의 mock API 에 붙었을 때) 계정 메뉴 없이 그린다.

import { api, auth } from '../api-client/client.js';
import { ROLE_LABELS } from '../lib/session.js';
import { envBadge } from './badges.js';
import { el } from './dom.js';
import { menuButton } from './menu.js';
import { errorNotice } from './notice.js';
import { toast } from './toast.js';

const TABS = [
  { key: 'create', label: 'Create', href: '/create' },
  { key: 'manage', label: 'Manage', href: '/manage' },
  { key: 'workers', label: 'Worker Pool', href: '/workers' },
];
const ADMIN_TABS = [{ key: 'users', label: 'Users', href: '/admin/users' }];
const WORKER_TABS = [{ key: 'worker-home', label: 'HITs', href: '/worker' }];

async function signOut() {
  try {
    await auth.logout();
  } catch (error) {
    toast.error('Sign out failed', error.message);
    return;
  }
  location.assign('/login');
}

/** 제목 줄 오른쪽의 계정 메뉴: 이름과 역할, Sign out. */
function accountMenu(user) {
  return menuButton({
    label: el('span', { className: 'account-label' }, user.displayName, el('span', { className: 'account-role' }, ROLE_LABELS[user.role] ?? user.role)),
    className: 'account-menu',
    items: [
      { key: 'email', label: user.email, disabled: true },
      { key: 'signout', label: 'Sign out', onClick: () => void signOut() },
    ],
  });
}

function navOf(tabs) {
  return el(
    'nav',
    { className: 'nav', 'aria-label': 'Main' },
    tabs.map((t) => el('a', { href: t.href, className: 'nav-link', dataset: { tab: t.key } }, t.label)),
  );
}

export function createLayout(root, session = null) {
  const user = session?.user ?? null;
  const envSlot = el('span', { className: 'topbar-env', id: 'env-badge' });
  const balance = el('span', { className: 'topbar-balance', id: 'balance' }, 'Balance …');
  const topbar = el(
    'header',
    { className: 'topbar' },
    el('a', { className: 'topbar-brand', href: '/manage' }, 'MTurk Console'),
    el('span', { className: 'topbar-right' }, envSlot, balance, user ? accountMenu(user) : null),
  );
  const nav = navOf(user?.role === 'admin' ? [...TABS, ...ADMIN_TABS] : TABS);
  const banner = el('div', { className: 'banner', id: 'banner' });
  const content = el('main', { className: 'content', id: 'content' });
  root.replaceChildren(topbar, nav, banner, content);

  function setBanner(node) {
    banner.replaceChildren();
    if (node) banner.append(node);
  }

  function setActive(key) {
    for (const link of nav.querySelectorAll('a')) link.classList.toggle('active', link.dataset.tab === key);
  }

  async function refreshAccount() {
    try {
      const account = await api.getAccount();
      envSlot.replaceChildren(envBadge(account.env));
      balance.textContent = `Balance $${account.AvailableBalance}`;
      setBanner(null);
    } catch (error) {
      envSlot.replaceChildren();
      balance.textContent = 'Balance –';
      setBanner(errorNotice(error, 'Account'));
    }
  }

  void refreshAccount();
  return { content, setActive, setBanner, refreshAccount };
}

export function createWorkerLayout(root, session) {
  const user = session.user;
  const topbar = el(
    'header',
    { className: 'topbar' },
    el('a', { className: 'topbar-brand', href: '/worker' }, 'MTurk Console', el('span', { className: 'topbar-sub' }, 'Worker')),
    el('span', { className: 'topbar-right' }, user.workerId ? el('span', { className: 'topbar-worker-id' }, user.workerId) : null, accountMenu(user)),
  );
  const nav = navOf(WORKER_TABS);
  const content = el('main', { className: 'content', id: 'content' });
  root.replaceChildren(topbar, nav, content);
  function setActive(key) {
    for (const link of nav.querySelectorAll('a')) link.classList.toggle('active', link.dataset.tab === key);
  }
  return { content, setActive };
}

export function createAuthLayout(root) {
  const content = el('main', { className: 'auth-content', id: 'content' });
  root.replaceChildren(content);
  return { content, setActive: () => {} };
}

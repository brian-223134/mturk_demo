// 공통 레이아웃: 제목 줄(환경 배지, 잔액), 세 탭(Create, Manage, Worker Pool), 오류 띠, 내용 영역.
// 환경 배지와 잔액은 getAccount 로 채운다. 실패하면(backend 가 내려가 있음) 오류 띠에 안내를 보여 주고 화면은 계속 뜬다.

import { api } from '../api-client/client.js';
import { envBadge } from './badges.js';
import { el } from './dom.js';
import { errorNotice } from './notice.js';

const TABS = [
  { key: 'create', label: 'Create', href: '/create' },
  { key: 'manage', label: 'Manage', href: '/manage' },
  { key: 'workers', label: 'Worker Pool', href: '/workers' },
];

export function createLayout(root) {
  const envSlot = el('span', { className: 'topbar-env', id: 'env-badge' });
  const balance = el('span', { className: 'topbar-balance', id: 'balance' }, 'Balance …');
  const topbar = el(
    'header',
    { className: 'topbar' },
    el('a', { className: 'topbar-brand', href: '/manage' }, 'MTurk Console'),
    el('span', { className: 'topbar-right' }, envSlot, balance),
  );
  const nav = el(
    'nav',
    { className: 'nav', 'aria-label': 'Main' },
    TABS.map((t) => el('a', { href: t.href, className: 'nav-link', dataset: { tab: t.key } }, t.label)),
  );
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

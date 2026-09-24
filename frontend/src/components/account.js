// 검수, 재모집, 만료는 잔액을 바꾼다. 제목 줄의 잔액(#balance, layout.js 가 만든다)을 getAccount 로 다시 채운다.

import { api } from '../api-client/client.js';
import { envBadge } from './badges.js';

export async function refreshBalance() {
  const balance = document.getElementById('balance');
  const env = document.getElementById('env-badge');
  if (!balance) return null;
  try {
    const account = await api.getAccount();
    balance.textContent = `Balance $${account.AvailableBalance}`;
    if (env) env.replaceChildren(envBadge(account.env));
    return account;
  } catch {
    return null; // 시작할 때의 오류 띠(layout.js)가 이미 안내한다
  }
}

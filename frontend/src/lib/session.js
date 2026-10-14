// 로그인, 가입, 역할별 첫 화면의 순수 로직. DOM 을 쓰지 않아 Node 테스트에서 그대로 import 한다.
// 검사 문구는 backend(app/accounts.py)와 같다. 화면에서 먼저 막아 주지만, 최종 판단은 언제나 backend 가 한다.

export const CONSOLE_ROLES = ['admin', 'requester'];
export const ROLE_LABELS = { admin: 'Admin', requester: 'Requester', worker: 'Worker' };

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const AUTH_PAGES = ['/login', '/signup'];

export function isConsoleRole(role) {
  return CONSOLE_ROLES.includes(role);
}

/** 역할의 첫 화면. requester 와 admin 은 콘솔(Create), worker 는 작업 화면. */
export function homePath(role) {
  return role === 'worker' ? '/worker' : '/create';
}

/** 그 역할로 열 수 있는 경로인지. worker 는 /worker 아래만, 콘솔 역할은 /worker 아래를 뺀 곳 (/admin 은 admin 만). */
export function pathAllowed(path, role) {
  const inWorker = path === '/worker' || path.startsWith('/worker/');
  if (role === 'worker') return inWorker;
  if (path === '/admin' || path.startsWith('/admin/')) return role === 'admin';
  return !inWorker;
}

/** 로그인 뒤 돌아갈 곳. 같은 사이트의 경로이고 그 역할로 열 수 있을 때만 받고, 아니면 첫 화면. */
export function safeNext(next, role) {
  if (typeof next !== 'string' || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return homePath(role);
  const path = next.split(/[?#]/)[0];
  if (path.startsWith('/api/') || AUTH_PAGES.includes(path) || path === '/') return homePath(role);
  return pathAllowed(path, role) ? next : homePath(role);
}

/** 로그인 화면 주소. next 가 있으면 로그인 뒤 그리로 돌아간다. */
export function loginPath(next) {
  if (!next || next === '/' || AUTH_PAGES.some((page) => next.startsWith(page))) return '/login';
  return `/login?next=${encodeURIComponent(next)}`;
}

/** 가입할 수 있는지와 초대 코드가 필요한지. options 는 GET /api/auth/options. requester 는 언제나 코드가 필요하다. */
export function signupRequirements(options, role) {
  if (role === 'requester') return { allowed: true, needsCode: true };
  const mode = options?.workerSignup ?? 'open';
  return { allowed: mode !== 'closed', needsCode: mode === 'invite' };
}

function emailDomainAllowed(email, domains) {
  if (!domains || domains.length === 0) return true;
  const host = email.split('@').pop();
  return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

/** 가입 폼의 첫 오류 문구, 없으면 null. values: { role, email, displayName, password, confirm, inviteCode } */
export function signupError(values, options) {
  const minLength = options?.passwordMinLength ?? 8;
  const domains = options?.emailDomains ?? [];
  const role = values.role;
  if (role !== 'worker' && role !== 'requester') return 'Choose an account type.';
  const { allowed, needsCode } = signupRequirements(options, role);
  if (!allowed) return 'Worker sign-up is closed. Ask the lab for an account.';
  const email = String(values.email ?? '').trim().toLowerCase();
  if (!email) return 'Email is required.';
  if (!EMAIL_RE.test(email) || email.length > 254) return 'Enter a valid email address.';
  if (!emailDomainAllowed(email, domains)) return `Sign-up is limited to these email domains: ${domains.join(', ')}.`;
  if (!String(values.displayName ?? '').trim()) return 'Name is required.';
  const password = String(values.password ?? '');
  if (!password) return 'Password is required.';
  if (password.length < minLength) return `Password must be at least ${minLength} characters.`;
  if (!password.trim()) return 'Password cannot be only spaces.';
  if (password !== String(values.confirm ?? '')) return 'The two passwords do not match.';
  if (needsCode && !String(values.inviteCode ?? '').replace(/[^A-Za-z0-9]/g, '')) {
    return role === 'requester' ? 'An invitation code is required to sign up as a requester.' : 'An invitation code is required to sign up.';
  }
  return null;
}

/** 로그인 폼의 첫 오류 문구, 없으면 null. */
export function loginError(values) {
  if (!String(values.email ?? '').trim()) return 'Email is required.';
  if (!String(values.password ?? '')) return 'Password is required.';
  return null;
}

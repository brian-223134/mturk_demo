// 로그인·가입의 순수 로직(src/lib/session.js) 검사. 역할별 첫 화면과 열 수 있는 경로, 로그인 뒤 돌아갈 곳(다른 사이트로 새지 않게),
// 가입 조건과 검사 문구(backend 의 app/accounts.py 와 같은 문구)를 본다.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { homePath, isConsoleRole, loginError, loginPath, pathAllowed, safeNext, signupError, signupRequirements } from '../src/lib/session.js';

const OPEN = { workerSignup: 'open', emailDomains: [], passwordMinLength: 8 };
const valid = { role: 'worker', email: 'kim@example.com', displayName: 'Kim', password: 'long enough', confirm: 'long enough', inviteCode: '' };

describe('역할과 경로', () => {
  it('첫 화면은 worker 면 /worker, 콘솔 역할이면 /create', () => {
    assert.equal(homePath('worker'), '/worker');
    assert.equal(homePath('requester'), '/create');
    assert.equal(homePath('admin'), '/create');
    assert.ok(isConsoleRole('admin') && isConsoleRole('requester') && !isConsoleRole('worker'));
  });

  it('worker 는 /worker 아래만, requester 는 /worker 와 /admin 을 뺀 곳, admin 은 /admin 도', () => {
    assert.ok(pathAllowed('/worker', 'worker') && pathAllowed('/worker/hits/1', 'worker'));
    assert.ok(!pathAllowed('/create', 'worker') && !pathAllowed('/workers', 'worker'));
    assert.ok(pathAllowed('/workers/W1', 'requester') && !pathAllowed('/worker', 'requester'));
    assert.ok(!pathAllowed('/admin/users', 'requester') && pathAllowed('/admin/users', 'admin'));
  });

  it('safeNext 는 같은 사이트에서 그 역할로 열 수 있는 경로만 돌려준다', () => {
    assert.equal(safeNext('/manage/b1/review?page=2', 'requester'), '/manage/b1/review?page=2');
    assert.equal(safeNext('/manage/b1', 'worker'), '/worker');
    assert.equal(safeNext('/admin/users', 'requester'), '/create');
    for (const bad of [null, '', 'manage', '//evil.example/x', '/\\evil.example', 'https://evil.example', '/api/batches', '/login', '/signup?x=1', '/']) {
      assert.equal(safeNext(bad, 'requester'), '/create', String(bad));
    }
  });

  it('loginPath 는 돌아갈 곳을 next 에 담는다 (첫 화면이나 로그인 화면이면 담지 않는다)', () => {
    assert.equal(loginPath('/manage/b1?tab=x'), '/login?next=%2Fmanage%2Fb1%3Ftab%3Dx');
    assert.equal(loginPath('/'), '/login');
    assert.equal(loginPath('/login?next=%2Fx'), '/login');
    assert.equal(loginPath(''), '/login');
  });
});

describe('가입 조건과 검사', () => {
  it('requester 는 언제나 초대 코드, worker 는 workerSignup 에 따라', () => {
    assert.deepEqual(signupRequirements(OPEN, 'requester'), { allowed: true, needsCode: true });
    assert.deepEqual(signupRequirements(OPEN, 'worker'), { allowed: true, needsCode: false });
    assert.deepEqual(signupRequirements({ workerSignup: 'invite' }, 'worker'), { allowed: true, needsCode: true });
    assert.deepEqual(signupRequirements({ workerSignup: 'closed' }, 'worker'), { allowed: false, needsCode: false });
    assert.deepEqual(signupRequirements(undefined, 'worker'), { allowed: true, needsCode: false });
  });

  it('올바른 값이면 null, 아니면 backend 와 같은 문구', () => {
    assert.equal(signupError(valid, OPEN), null);
    const cases = [
      [{ email: ' ' }, 'Email is required.'],
      [{ email: 'no-at' }, 'Enter a valid email address.'],
      [{ displayName: '  ' }, 'Name is required.'],
      [{ password: 'short', confirm: 'short' }, 'Password must be at least 8 characters.'],
      [{ password: '         ', confirm: '         ' }, 'Password cannot be only spaces.'],
      [{ confirm: 'different!' }, 'The two passwords do not match.'],
      [{ role: 'requester' }, 'An invitation code is required to sign up as a requester.'],
      [{ role: 'admin' }, 'Choose an account type.'],
    ];
    for (const [patch, message] of cases) assert.equal(signupError({ ...valid, ...patch }, OPEN), message, message);
    assert.equal(signupError({ ...valid, role: 'requester', inviteCode: 'abcd-efgh-jkmn' }, OPEN), null);
    assert.equal(signupError(valid, { ...OPEN, workerSignup: 'invite' }), 'An invitation code is required to sign up.');
    assert.equal(signupError(valid, { ...OPEN, workerSignup: 'closed' }), 'Worker sign-up is closed. Ask the lab for an account.');
    assert.equal(signupError({ ...valid, password: 'abcdefghij', confirm: 'abcdefghij' }, { ...OPEN, passwordMinLength: 12 }), 'Password must be at least 12 characters.');
  });

  it('이메일 도메인 제한은 하위 도메인도 받는다', () => {
    const limited = { ...OPEN, emailDomains: ['example.ac.kr'] };
    assert.equal(signupError(valid, limited), 'Sign-up is limited to these email domains: example.ac.kr.');
    assert.equal(signupError({ ...valid, email: 'kim@cs.example.ac.kr' }, limited), null);
  });

  it('로그인 폼은 빈 칸만 막는다', () => {
    assert.equal(loginError({ email: '', password: 'x' }), 'Email is required.');
    assert.equal(loginError({ email: 'a@b.c', password: '' }), 'Password is required.');
    assert.equal(loginError({ email: 'a@b.c', password: 'x' }), null);
  });
});

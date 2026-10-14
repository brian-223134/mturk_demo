// 로그인(/login)과 가입(/signup) 화면. 로그인하지 않았을 때만 보인다 (main.js).
// 성공하면 페이지를 새로 불러 역할에 맞는 화면(콘솔 또는 worker 화면)으로 시작한다. 검사 규칙은 lib/session.js.

import { auth, isApiError } from '../api-client/client.js';
import { el } from '../components/dom.js';
import { notice } from '../components/notice.js';
import { replace } from '../components/render.js';
import { homePath, loginError, safeNext, signupError, signupRequirements } from '../lib/session.js';

function field({ label, input, hint }) {
  return el('div', { className: 'field' }, el('label', { for: input.id }, label), input, hint ? el('div', { className: 'hint' }, hint) : null);
}

function textInput(id, type, attrs = {}) {
  return el('input', { id, name: id, type, className: 'input', ...attrs });
}

function card(title, subtitle, ...children) {
  return el(
    'div',
    { className: 'auth-page' },
    el('div', { className: 'auth-brand' }, 'MTurk Console'),
    el('section', { className: 'auth-card' }, el('h1', { className: 'auth-title' }, title), subtitle ? el('p', { className: 'muted auth-subtitle' }, subtitle) : null, ...children),
  );
}

function showError(slot, error) {
  const message = typeof error === 'string' ? error : error?.message ?? String(error);
  const title = isApiError(error, 'NETWORK') ? 'Cannot reach the server' : 'Could not continue';
  replace(slot, notice('error', title, message));
}

function setBusy(form, busy, button, idleLabel, busyLabel) {
  for (const node of form.elements) node.disabled = busy;
  button.textContent = busy ? busyLabel : idleLabel;
}

// ---- /login ---------------------------------------------------------------------------------

export function renderLogin(container) {
  const next = new URLSearchParams(location.search).get('next');
  const message = el('div', { className: 'auth-message' });
  const email = textInput('login-email', 'email', { autocomplete: 'username', required: true, autofocus: true });
  const password = textInput('login-password', 'password', { autocomplete: 'current-password', required: true });
  const submit = el('button', { type: 'submit', className: 'btn btn-primary btn-block' }, 'Sign in');
  const form = el('form', { className: 'form auth-form', noValidate: true }, field({ label: 'Email', input: email }), field({ label: 'Password', input: password }), submit);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const values = { email: email.value, password: password.value };
    const problem = loginError(values);
    if (problem) return showError(message, problem);
    replace(message);
    setBusy(form, true, submit, 'Sign in', 'Signing in…');
    try {
      const { user } = await auth.login(values.email.trim(), values.password);
      location.assign(safeNext(next, user.role));
    } catch (error) {
      setBusy(form, false, submit, 'Sign in', 'Signing in…');
      showError(message, error);
      password.select();
    }
  });

  container.append(
    card(
      'Sign in',
      'Requesters manage annotation projects here; workers take HITs.',
      next ? notice('info', 'Sign in to continue', null) : null,
      message,
      form,
      el('p', { className: 'auth-switch' }, 'No account yet? ', el('a', { href: '/signup' }, 'Create an account')),
    ),
  );
  email.focus();
}

// ---- /signup --------------------------------------------------------------------------------

const ROLE_CHOICES = [
  { value: 'worker', label: 'Worker', hint: 'Take annotation tasks (HITs).' },
  { value: 'requester', label: 'Requester', hint: 'Create projects and review the answers. Needs an invitation code from the lab.' },
];

export async function renderSignup(container, _params, signal) {
  let options = { workerSignup: 'open', emailDomains: [], passwordMinLength: 8 };
  const message = el('div', { className: 'auth-message' });
  try {
    options = await auth.options();
  } catch (error) {
    showError(message, error);
  }
  if (signal?.aborted) return;

  const roleInputs = ROLE_CHOICES.map((choice) =>
    el('input', { type: 'radio', name: 'role', id: `signup-role-${choice.value}`, value: choice.value, checked: choice.value === 'worker' }),
  );
  const roleField = el(
    'fieldset',
    { className: 'field role-choice' },
    el('legend', {}, 'Account type'),
    ROLE_CHOICES.map((choice, i) =>
      el('label', { className: 'role-option', for: roleInputs[i].id }, roleInputs[i], el('span', { className: 'role-option-text' }, el('strong', {}, choice.label), el('span', { className: 'hint' }, choice.hint))),
    ),
  );
  const domainHint = options.emailDomains.length ? `Use an address at ${options.emailDomains.join(' or ')}.` : 'This is your sign-in ID. Requesters never see it.';
  const email = textInput('signup-email', 'email', { autocomplete: 'email', required: true });
  const name = textInput('signup-name', 'text', { autocomplete: 'name', required: true, maxlength: '80' });
  const password = textInput('signup-password', 'password', { autocomplete: 'new-password', required: true });
  const confirm = textInput('signup-confirm', 'password', { autocomplete: 'new-password', required: true });
  const code = textInput('signup-code', 'text', { autocomplete: 'off', placeholder: 'XXXX-XXXX-XXXX', spellcheck: 'false' });
  const codeField = field({ label: 'Invitation code', input: code, hint: 'The lab gives you this code.' });
  const closedNotice = notice('warning', 'Worker sign-up is closed', 'Ask the lab for an invitation, or choose another account type.');
  const submit = el('button', { type: 'submit', className: 'btn btn-primary btn-block' }, 'Create account');

  const form = el(
    'form',
    { className: 'form auth-form', noValidate: true },
    roleField,
    closedNotice,
    field({ label: 'Email', input: email, hint: domainHint }),
    field({ label: 'Name', input: name, hint: 'Shown to the lab administrator.' }),
    field({ label: 'Password', input: password, hint: `At least ${options.passwordMinLength} characters.` }),
    field({ label: 'Repeat the password', input: confirm }),
    codeField,
    submit,
  );

  const selectedRole = () => roleInputs.find((input) => input.checked)?.value ?? 'worker';
  function sync() {
    const { allowed, needsCode } = signupRequirements(options, selectedRole());
    codeField.hidden = !needsCode;
    closedNotice.hidden = allowed;
    submit.disabled = !allowed;
  }
  for (const input of roleInputs) input.addEventListener('change', sync);
  sync();

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const values = { role: selectedRole(), email: email.value, displayName: name.value, password: password.value, confirm: confirm.value, inviteCode: code.value };
    const problem = signupError(values, options);
    if (problem) return showError(message, problem);
    replace(message);
    setBusy(form, true, submit, 'Create account', 'Creating…');
    try {
      const { needsCode } = signupRequirements(options, values.role);
      const { user } = await auth.signup({
        role: values.role,
        email: values.email.trim(),
        displayName: values.displayName.trim(),
        password: values.password,
        inviteCode: needsCode ? values.inviteCode.trim() : undefined,
      });
      location.assign(homePath(user.role));
    } catch (error) {
      setBusy(form, false, submit, 'Create account', 'Creating…');
      sync();
      showError(message, error);
    }
  });

  container.append(
    card('Create an account', null, message, form, el('p', { className: 'auth-switch' }, 'Already have an account? ', el('a', { href: '/login' }, 'Sign in'))),
  );
}

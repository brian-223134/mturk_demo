// admin 의 사용자 관리(/admin/users): 계정 목록과 정지·해제, 가입 초대 코드 만들기와 지우기.
// 초대 코드 원문은 만들 때 한 번만 보여 준다 (backend 는 해시만 둔다).

import { admin } from '../api-client/client.js';
import { tag } from '../components/badges.js';
import { el } from '../components/dom.js';
import { formatDateTime } from '../components/format.js';
import { confirmModal, openModal } from '../components/modal.js';
import { errorNotice, loading, notice } from '../components/notice.js';
import { replace } from '../components/render.js';
import { table } from '../components/table.js';
import { toast } from '../components/toast.js';
import { ROLE_LABELS } from '../lib/session.js';

const ROLE_COLORS = { admin: 'red', requester: 'blue', worker: 'default' };
const STATUS_COLORS = { active: 'green', suspended: 'warning', used: 'muted', expired: 'muted' };

const roleTag = (role) => tag(ROLE_LABELS[role] ?? role, ROLE_COLORS[role] ?? 'default');
const statusTag = (status) => tag(status[0].toUpperCase() + status.slice(1), STATUS_COLORS[status] ?? 'default');

export async function renderUsers(container, _params, signal, session) {
  const usersSlot = el('div', {}, loading());
  const invitationsSlot = el('div', {}, loading());
  container.append(
    el('div', { className: 'page-title' }, el('h2', {}, 'Users')),
    el(
      'section',
      { className: 'panel' },
      el('div', { className: 'panel-head' }, el('h3', { className: 'panel-title' }, 'Invitation codes'),
        el('button', { type: 'button', className: 'btn btn-primary', onClick: () => openInvitationForm(reload) }, 'New invitation code')),
      el('p', { className: 'muted' }, 'Requesters can sign up only with a code. Workers need one when worker sign-up is set to invite.'),
      invitationsSlot,
    ),
    el('section', { className: 'panel' }, el('h3', { className: 'panel-title' }, 'Accounts'), usersSlot),
  );

  async function reload() {
    try {
      const [{ users }, { invitations }] = await Promise.all([admin.listUsers(), admin.listInvitations()]);
      if (signal.aborted) return;
      replace(usersSlot, usersTable(users, session.user.id, reload));
      replace(invitationsSlot, invitationsTable(invitations, reload));
    } catch (error) {
      if (signal.aborted) return;
      replace(usersSlot, errorNotice(error, 'Users'));
      replace(invitationsSlot);
    }
  }
  await reload();
}

function usersTable(users, myId, reload) {
  async function setStatus(user, status) {
    if (status === 'suspended') {
      const ok = await confirmModal({
        title: `Suspend ${user.displayName}?`,
        message: 'They are signed out at once and cannot sign in until you activate the account again.',
        okText: 'Suspend',
        danger: true,
      });
      if (!ok) return;
    }
    try {
      await (status === 'suspended' ? admin.suspendUser(user.id) : admin.activateUser(user.id));
      toast.success(`${user.email} is ${status}.`);
      await reload();
    } catch (error) {
      toast.error('Could not change the account', error.message);
    }
  }
  return table({
    rowKey: (user) => user.id,
    empty: 'No accounts',
    rows: users,
    columns: [
      { title: 'Name', render: (user) => [user.displayName, user.id === myId ? el('span', { className: 'muted' }, ' (you)') : null] },
      { title: 'Email', render: (user) => user.email },
      { title: 'Role', render: (user) => roleTag(user.role) },
      { title: 'Status', render: (user) => statusTag(user.status) },
      { title: 'Worker ID', render: (user) => (user.workerId ? el('code', {}, user.workerId) : '–') },
      { title: 'Created', render: (user) => formatDateTime(user.createdAt) },
      { title: 'Last sign-in', render: (user) => formatDateTime(user.lastLoginAt) },
      {
        title: '',
        align: 'right',
        render: (user) =>
          user.id === myId
            ? null
            : user.status === 'active'
              ? el('button', { type: 'button', className: 'btn btn-small', onClick: () => setStatus(user, 'suspended') }, 'Suspend')
              : el('button', { type: 'button', className: 'btn btn-small', onClick: () => setStatus(user, 'active') }, 'Activate'),
      },
    ],
  });
}

function invitationsTable(invitations, reload) {
  async function remove(invitation) {
    try {
      await admin.deleteInvitation(invitation.id);
      toast.success('Invitation code deleted.');
      await reload();
    } catch (error) {
      toast.error('Could not delete the code', error.message);
    }
  }
  return table({
    rowKey: (invitation) => invitation.id,
    empty: 'No invitation codes yet',
    rows: invitations,
    columns: [
      { title: 'Role', render: (inv) => roleTag(inv.role) },
      { title: 'Only for', render: (inv) => inv.email ?? 'Anyone' },
      { title: 'Note', render: (inv) => inv.note || '–' },
      { title: 'Status', render: (inv) => statusTag(inv.status) },
      { title: 'Expires', render: (inv) => formatDateTime(inv.expiresAt) },
      { title: 'Used by', render: (inv) => inv.usedBy ?? '–' },
      { title: 'Created by', render: (inv) => inv.createdBy ?? 'command line' },
      {
        title: '',
        align: 'right',
        render: (inv) => (inv.status === 'used' ? null : el('button', { type: 'button', className: 'btn btn-small', onClick: () => remove(inv) }, 'Delete')),
      },
    ],
  });
}

function openInvitationForm(reload) {
  const role = el('select', { id: 'invite-role' }, el('option', { value: 'requester' }, 'Requester'), el('option', { value: 'worker' }, 'Worker'));
  const email = el('input', { id: 'invite-email', type: 'email', className: 'input', placeholder: 'Optional' });
  const note = el('input', { id: 'invite-note', type: 'text', className: 'input', maxlength: '200', placeholder: 'Optional, e.g. who it is for' });
  const days = el('input', { id: 'invite-days', type: 'number', className: 'input', min: '1', max: '90', value: '14' });
  const message = el('div');
  const row = (label, input, hint) => el('div', { className: 'field' }, el('label', { for: input.id }, label), input, hint ? el('div', { className: 'hint' }, hint) : null);

  openModal({
    title: 'New invitation code',
    content: [
      message,
      row('Account type', role),
      row('Only for this email', email, 'Leave empty to let anyone use the code once.'),
      row('Note', note),
      row('Expires in (days)', days),
    ],
    buttons: [
      { key: 'cancel', label: 'Cancel', onClick: (h) => h.close() },
      {
        key: 'create',
        label: 'Create code',
        kind: 'primary',
        onClick: async (h) => {
          try {
            const { code, invitation } = await admin.createInvitation({
              role: role.value,
              email: email.value.trim() || null,
              note: note.value.trim(),
              expiresInDays: Number(days.value),
            });
            h.close();
            showCode(code, invitation);
            await reload();
          } catch (error) {
            replace(message, errorNotice(error, 'Invitation'));
          }
        },
      },
    ],
  });
}

function showCode(code, invitation) {
  const copy = el('button', { type: 'button', className: 'btn btn-small' }, 'Copy');
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(code);
      copy.textContent = 'Copied';
    } catch {
      copy.textContent = 'Select and copy';
    }
  });
  openModal({
    title: 'Invitation code',
    content: [
      el('p', { className: 'invitation-code' }, el('code', { dataset: { code } }, code), ' ', copy),
      notice('warning', 'This code is shown only once', `Send it to the person who will sign up as a ${ROLE_LABELS[invitation.role].toLowerCase()}. It expires ${formatDateTime(invitation.expiresAt)}.`),
    ],
    buttons: [{ key: 'ok', label: 'Done', kind: 'primary', onClick: (h) => h.close() }],
  });
}

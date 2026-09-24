// pool 생성. 이름 중복 같은 검증은 API 가 하고, 그 오류를 이름 칸 아래에 그대로 보여준다. openCreatePoolModal({ onCreated(pool) })

import { api } from '../../api-client/client.js';
import { isApiError } from '../../api-client/client.js';
import { el } from '../../components/dom.js';
import { textArea } from '../../components/filters.js';
import { openModal } from '../../components/modal.js';
import { toast } from '../../components/toast.js';
import { errorText } from './shared.js';

export function openCreatePoolModal({ onCreated }) {
  let name = '';
  let description = '';
  const nameError = el('div', { className: 'hint text-critical', id: 'pool-name-error', hidden: true });
  const nameInput = el('input', { id: 'pool-name', type: 'text', className: 'input', maxlength: '60', placeholder: 'e.g. Trusted (pilot round)', autofocus: true, onInput: (event) => { name = event.target.value; nameError.hidden = true; } });

  const submit = async (h) => {
    if (!name.trim()) {
      nameError.textContent = 'Pool name is required.';
      nameError.hidden = false;
      nameInput.focus();
      return;
    }
    try {
      const pool = await api.createPool({ name: name.trim(), description: description.trim() });
      toast.success(`Created pool "${pool.name}".`);
      h.close();
      onCreated?.(pool);
    } catch (error) {
      // createPool 의 INVALID_REQUEST 는 전부 이름에 관한 것이다 (빈 이름, 중복)
      if (isApiError(error, 'INVALID_REQUEST')) {
        nameError.textContent = errorText(error);
        nameError.hidden = false;
      } else toast.error('Could not create the pool', errorText(error));
    }
  };

  const modal = openModal({
    title: 'New pool',
    className: 'modal-create-pool',
    content: el(
      'form',
      { className: 'form', onSubmit: (event) => { event.preventDefault(); void submit(modal); } },
      el('div', { className: 'field' }, el('label', { for: 'pool-name' }, 'Name'), nameInput, nameError, el('div', { className: 'hint' }, 'Shown in Create › Settings when choosing pools to require or exclude.')),
      el('div', { className: 'field' }, el('label', { for: 'pool-description' }, 'Description (optional)'), textArea({ id: 'pool-description', rows: 3, maxLength: 300, placeholder: 'What this pool is for', onInput: (v) => { description = v; } })),
    ),
    buttons: [
      { key: 'cancel', label: 'Cancel', onClick: (h) => h.close() },
      { key: 'ok', label: 'Create pool', kind: 'primary', onClick: (h) => submit(h) },
    ],
  });
  nameInput.focus();
  return modal;
}

// 차단 안내. 차단은 worker 계정에 불이익을 줄 수 있어서 기본 동선은 "Excluded pool 에 추가"이고,
// 차단은 사유를 적어야만 할 수 있는 두 번째 선택지다. openBlockModal({ workerIds, pools, onDone })

import { el } from '../../components/dom.js';
import { selectInput, textArea } from '../../components/filters.js';
import { openModal } from '../../components/modal.js';
import { notice } from '../../components/notice.js';
import { EXCLUDED_POOL_ID, countWorkers, workerActions } from './shared.js';

const SHOWN_IDS = 8;

export function openBlockModal({ workerIds, pools = [], onDone }) {
  const excluded = pools.find((p) => p.id === EXCLUDED_POOL_ID);
  let pickedPoolId = '';
  let blockAnyway = false;
  let reason = '';
  const who = workerIds.length === 1 ? 'this worker' : 'these workers';
  const targetPool = () => excluded ?? pools.find((p) => p.id === pickedPoolId);
  // 이미 전원이 제외 pool 에 있으면 기본 동선이 할 일이 없다
  const allExcluded = () => {
    const pool = targetPool();
    return Boolean(pool) && workerIds.every((id) => pool.workerIds.includes(id));
  };

  const reasonHelp = el('div', { className: 'hint', id: 'block-reason-help' }, 'MTurk records the reason with the block.');
  const reasonBox = el(
    'div',
    { className: 'field', id: 'block-reason', hidden: true },
    el('label', { for: 'block-reason-text' }, 'Reason for blocking'),
    textArea({ id: 'block-reason-text', rows: 2, maxLength: 1024, placeholder: 'e.g. Repeatedly submitted answers that fail the attention check.', onInput: (v) => { reason = v; reasonHelp.textContent = 'MTurk records the reason with the block.'; reasonHelp.classList.remove('text-critical'); } }),
    reasonHelp,
  );

  let recommendation;
  if (excluded && allExcluded()) {
    recommendation = el('p', { className: 'modal-text' }, `${workerIds.length === 1 ? 'This worker is' : 'These workers are'} already in the `, el('b', {}, excluded.name), ' pool, so batches that exclude this pool (Create › Settings) stay hidden from them. Blocking adds little on top of that.');
  } else if (excluded) {
    recommendation = el('p', { className: 'modal-text' }, el('b', {}, 'Recommended:'), ` add ${who} to the `, el('b', {}, excluded.name), ' pool. Batches that exclude this pool (Create › Settings) stay hidden from them.');
  } else {
    recommendation = el(
      'div',
      {},
      el('p', { className: 'modal-text' }, el('b', {}, 'Recommended:'), ` add ${who} to an exclusion pool. There is no "Excluded" pool in this data, so choose which pool to use.`),
      selectInput({
        id: 'block-pool',
        value: '',
        options: [{ value: '', label: pools.length > 0 ? 'Choose a pool' : 'No pools yet. Create one under Pools.' }, ...pools.map((p) => ({ value: p.id, label: `${p.name} (${p.workerIds.length})` }))],
        onChange: (value) => { pickedPoolId = value; syncButtons(); },
      }),
    );
  }

  const excludeLabel = () => {
    const pool = targetPool();
    if (pool && allExcluded()) return `Already in "${pool.name}"`;
    return excluded || !pool ? 'Add to Excluded pool instead' : `Add to "${pool.name}" instead`;
  };

  const modal = openModal({
    title: `Block ${countWorkers(workerIds.length)}?`,
    width: 600,
    className: 'modal-block',
    content: [
      notice('warning', "Blocking can harm the worker's MTurk account", 'Blocks count against the worker on MTurk, and accumulated blocks can penalize the account. For research the convention is an exclusion pool instead: excluded workers simply do not see your HITs, and nothing is held against them.'),
      el('div', { className: 'id-list' }, workerIds.slice(0, SHOWN_IDS).map((id) => el('code', {}, id)), workerIds.length > SHOWN_IDS ? el('span', { className: 'muted' }, `and ${workerIds.length - SHOWN_IDS} more`) : null),
      recommendation,
      reasonBox,
    ],
    buttons: [
      { key: 'cancel', label: 'Cancel', onClick: (h) => h.close() },
      {
        key: 'block',
        label: 'Block anyway…',
        kind: 'danger',
        onClick: async (h) => {
          if (!blockAnyway) {
            blockAnyway = true;
            reasonBox.hidden = false;
            reasonBox.querySelector('textarea').focus();
            h.setButton('block', { label: `Block ${countWorkers(workerIds.length)}` });
            return;
          }
          if (!reason.trim()) {
            reasonHelp.textContent = 'A reason is required to block. MTurk records it.';
            reasonHelp.classList.add('text-critical');
            return;
          }
          if (await workerActions.block(workerIds, reason.trim())) {
            h.close();
            onDone?.();
          }
        },
      },
      {
        key: 'exclude',
        label: excludeLabel(),
        kind: 'primary',
        autofocus: true,
        disabled: !targetPool() || allExcluded(),
        onClick: async (h) => {
          const pool = targetPool();
          if (!pool) return;
          if (await workerActions.addToPool(pool, workerIds)) {
            h.close();
            onDone?.();
          }
        },
      },
    ],
  });
  function syncButtons() {
    modal.setButton('exclude', { label: excludeLabel(), disabled: !targetPool() || allExcluded() });
  }
  return modal;
}

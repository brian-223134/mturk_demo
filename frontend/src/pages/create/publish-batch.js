// Publish Batch: /create/publish/:projectId. MTurk 에서 Project 의 "Publish Batch" 를 누른 뒤의 흐름이다.
//   (1) Upload CSV → (2) Preview tasks → (3) Review settings → (4) Confirm and publish
// 보상, 인원, 기간, worker 조건은 Project 의 속성을 그대로 쓴다 (바꾸려면 Project 를 고친다). 이 batch 에서 정하는 것은 CSV 와
// 검수 설정(attention, 자유 서술, 대조 기준)뿐이다. 입력은 draft 하나에 모아 IndexedDB 에 임시 저장한다 (lib/draft.js).
// 임시 저장은 한 번에 하나다: 다른 Project 의 Publish Batch 를 열면 이전 것을 바꾼다.
//
// 단계 모듈의 계약: renderXStep(ctx) → { node, cleanup? }.
//  - ctx.draft: 현재 draft (읽기). ctx.update(change, { rerender = true }): 일부를 바꾸고 저장을 예약하며 기본으로 단계를 다시 그린다.
//    글자를 칠 때는 rerender: false 로 불러 커서를 유지한다.
//  - ctx.goTo(step), ctx.rerender(), ctx.reset(), ctx.signal
//  - ctx.template(게시할 Project), ctx.pools / account (+ *Error), ctx.check(Data 검사), ctx.estimate(견적)

import { api, isApiError } from '../../api-client/client.js';
import { el } from '../../components/dom.js';
import { formatDateTime } from '../../components/format.js';
import { errorNotice, loading, notice } from '../../components/notice.js';
import { checkData } from '../../lib/data-check.js';
import { LAST_STEP, STEP_TITLES, draftStorage, emptyDraft } from '../../lib/draft.js';
import { estimateFor, settingsFromProperties, withProjectProperties } from '../../lib/settings.js';
import { createSubnav } from './common.js';
import { renderDataStep } from './data-step.js';
import { renderPreviewStep } from './preview-step.js';
import { renderConfirmStep } from './publish-step.js';
import { renderQualityStep } from './quality-step.js';

const SAVE_DEBOUNCE_MS = 400;
const STEP_RENDERERS = [renderDataStep, renderPreviewStep, renderQualityStep, renderConfirmStep];

const settle = (promise) => promise.then((value) => ({ value, error: null })).catch((error) => ({ value: null, error }));

/** 이 Project 로 새로 시작하는 draft. 검수 설정도 Project 에 저장된 값(지난 설정이나 agent 의 settings.json)에서 시작한다. */
export function freshDraft(project) {
  return { ...emptyDraft(), templateId: project.id, settings: settingsFromProperties(project.properties) };
}

export async function renderPublishBatch(root, params, signal) {
  const storage = draftStorage();
  const projectId = params.projectId;
  root.append(loading());

  const [loaded, templateResult, pools, account] = await Promise.all([storage.load(), settle(api.getTemplate(projectId)), settle(api.listPools()), settle(api.getAccount())]);
  if (signal.aborted) return undefined;
  root.replaceChildren();
  if (templateResult.error) {
    root.append(
      el('div', { className: 'page-header' }, el('h2', { className: 'page-title' }, 'Publish batch')),
      createSubnav('projects'),
      isApiError(templateResult.error, 'NOT_FOUND') ? notice('error', `Project ${projectId} does not exist.`, 'It may have been deleted.') : errorNotice(templateResult.error, 'Project'),
      el('p', {}, el('a', { href: '/create' }, 'Back to projects')),
    );
    return undefined;
  }
  const project = templateResult.value;

  const state = {
    draft: null,
    restoredFrom: null,
    replaced: null,
    dirty: false, // 사용자가 아무것도 바꾸지 않았으면 쓰지 않는다 (게시 직후의 재저장을 막는다)
    saveTimer: null,
    stepCleanup: null,
    checkCache: { key: null, data: null, check: null },
  };
  if (loaded && loaded.draft.templateId === project.id) {
    storage.markCsvStored(loaded.draft.data);
    state.draft = loaded.draft;
    state.restoredFrom = loaded.savedAt || null;
  } else {
    if (loaded?.draft.data) state.replaced = loaded.draft.data.fileName;
    state.draft = freshDraft(project);
  }
  // 속성은 언제나 Project 의 지금 값이다 (draft 를 만든 뒤 Project 를 고쳤을 수 있다)
  state.draft = { ...state.draft, settings: withProjectProperties(state.draft.settings, project.properties) };

  const restoredText = el('span', { className: 'muted', id: 'draft-restored' });
  const startOver = el('button', { type: 'button', className: 'btn btn-small', id: 'start-over' }, 'Start over');
  const stepsBar = el('nav', { className: 'wizard-steps', id: 'wizard-steps', 'aria-label': 'Steps' });
  const body = el('div', { id: 'wizard-body' });
  // root.append 는 el() 과 달리 null 을 글자로 넣으므로 걸러 낸다
  const parts = [
    el('div', { className: 'page-header' }, el('h2', { className: 'page-title' }, 'Publish batch'), el('span', { className: 'page-header-right' }, restoredText, startOver)),
    createSubnav('projects'),
    el(
      'div',
      { className: 'publish-project', id: 'publish-project' },
      el('span', { className: 'muted' }, 'Project '),
      el('strong', { id: 'publish-project-name' }, project.name),
      el('a', { href: `/create/project/${encodeURIComponent(project.id)}/properties`, className: 'btn btn-small btn-link', id: 'edit-project' }, 'Edit project'),
      el('a', { href: '/create', className: 'btn btn-small btn-link' }, 'Back to projects'),
    ),
    state.replaced ? notice('info', `The unfinished batch with ${state.replaced} for another project was replaced by this one.`) : null,
    el('section', { className: 'panel panel-steps' }, stepsBar),
    body,
  ];
  root.append(...parts.filter(Boolean));

  // ── 저장 ──
  function flush() {
    if (state.saveTimer) clearTimeout(state.saveTimer);
    state.saveTimer = null;
    if (!state.dirty) return;
    state.dirty = false;
    void storage.save(state.draft);
  }
  function scheduleSave() {
    state.dirty = true;
    if (state.saveTimer) clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(flush, SAVE_DEBOUNCE_MS);
  }
  window.addEventListener('pagehide', flush);
  if (!loaded || loaded.draft.templateId !== project.id) scheduleSave();

  function currentCheck() {
    const { data } = state.draft;
    if (!data) return null;
    // 수 MB 의 CSV 를 훑으므로 placeholder 나 CSV 가 바뀔 때만 다시 계산한다
    const key = project.placeholders.join('\n');
    if (state.checkCache.data === data && state.checkCache.key === key) return state.checkCache.check;
    const check = checkData(project.placeholders, data.columns, data.rows);
    state.checkCache = { key, data, check };
    return check;
  }

  /** CSV 가 없거나 컬럼이 모자라면 Upload CSV 로 돌려보낸다. 사라진 pool 이 남아 있으면 게시가 실패하므로 걸러 낸다. */
  function reconcile() {
    if (pools.value) {
      const known = new Set(pools.value.map((p) => p.id));
      const { requiredPoolIds, excludedPoolIds } = state.draft.settings;
      if (![...requiredPoolIds, ...excludedPoolIds].every((id) => known.has(id))) {
        state.draft = {
          ...state.draft,
          settings: { ...state.draft.settings, requiredPoolIds: requiredPoolIds.filter((id) => known.has(id)), excludedPoolIds: excludedPoolIds.filter((id) => known.has(id)) },
        };
      }
    }
    const check = currentCheck();
    const maxStep = !state.draft.data || !check || check.missingColumns.length > 0 ? 0 : LAST_STEP;
    if (state.draft.step > maxStep) {
      state.draft = { ...state.draft, step: maxStep };
      scheduleSave();
    }
    return check;
  }

  const ctx = {
    signal,
    get draft() {
      return state.draft;
    },
    template: project,
    pools: pools.value,
    poolsError: pools.error,
    account: account.value,
    accountError: account.error,
    check: null,
    estimate: null,
    update(change, { rerender = true } = {}) {
      const patch = typeof change === 'function' ? change(state.draft) : change;
      state.draft = { ...state.draft, ...patch };
      scheduleSave();
      if (rerender) renderAll();
    },
    goTo(next) {
      ctx.update({ step: Math.min(Math.max(0, next), LAST_STEP) });
      window.scrollTo(0, 0);
    },
    rerender: () => renderAll(),
    /** 게시가 끝나면 입력을 비운다 (저장본도 지운다). */
    reset({ rerender = true } = {}) {
      if (state.saveTimer) clearTimeout(state.saveTimer);
      state.saveTimer = null;
      state.dirty = false;
      state.restoredFrom = null;
      state.draft = freshDraft(project);
      storage.markCsvStored(null);
      void storage.clear();
      if (rerender) renderAll();
    },
  };

  startOver.addEventListener('click', () => {
    if (!window.confirm('Start over? The uploaded CSV and the review settings of this batch are discarded. The project is not changed.')) return;
    ctx.reset();
  });

  function renderStepsBar(step) {
    stepsBar.replaceChildren(
      ...STEP_TITLES.map((title, index) =>
        el(
          'button',
          {
            type: 'button',
            className: `wizard-step${index === step ? ' active' : index < step ? ' done' : ''}`,
            dataset: { index: String(index) },
            // 앞으로 가는 것은 각 단계의 검증을 거치는 Next 로만 한다
            disabled: index > step,
            'aria-current': index === step ? 'step' : null,
            onClick: () => index < step && ctx.goTo(index),
          },
          el('span', { className: 'wizard-step-number' }, String(index + 1)),
          el('span', { className: 'wizard-step-title' }, title),
        ),
      ),
    );
  }

  function renderAll() {
    if (signal.aborted) return;
    ctx.check = reconcile();
    ctx.estimate = estimateFor(state.draft.settings, state.draft.data?.rows.length ?? 0);
    const { draft } = state;
    const hasInput = draft.data !== null || draft.step > 0;
    restoredText.textContent = state.restoredFrom && hasInput ? `Draft restored (saved ${formatDateTime(state.restoredFrom)})` : '';
    startOver.disabled = !hasInput;
    renderStepsBar(draft.step);

    if (typeof state.stepCleanup === 'function') state.stepCleanup();
    state.stepCleanup = null;
    const result = STEP_RENDERERS[draft.step](ctx);
    state.stepCleanup = result.cleanup ?? null;
    body.replaceChildren(result.node);
  }

  renderAll();

  return () => {
    if (typeof state.stepCleanup === 'function') state.stepCleanup();
    state.stepCleanup = null;
    window.removeEventListener('pagehide', flush);
    flush();
  };
}

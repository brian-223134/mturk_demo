// Create: 템플릿과 CSV 를 받아 batch 를 게시하는 5단계 마법사 (Template → Data → Settings → Preview & Cost → Publish).
// 입력은 draft 하나에 모으고(lib/draft.js, IndexedDB 에 임시 저장), 각 단계(pages/create/*.js)는 draft 의 일부를 읽고 고친다.
// Template 단계의 세 번째 방법 `Generate from raw data` 가 agent job 패널이다 (pages/create/generate.js).
//
// 단계 모듈의 계약: renderXStep(ctx) → { node, cleanup? }. ctx 는 아래 makeContext 가 만든다.
//  - ctx.draft: 현재 draft (읽기). ctx.update(change, { rerender = true }): 일부를 바꾸고 저장을 예약하며 기본으로 단계를 다시 그린다.
//    글자를 칠 때는 rerender: false 로 불러 커서를 유지한다.
//  - ctx.goTo(step), ctx.rerender(), ctx.reset(), ctx.setTemplates(list), ctx.signal
//  - ctx.templates / pools / account (+ *Error), ctx.template(고른 템플릿), ctx.check(Data 검사), ctx.estimate(견적)

import { api } from '../api-client/client.js';
import { el } from '../components/dom.js';
import { formatDateTime } from '../components/format.js';
import { loading } from '../components/notice.js';
import { checkData } from '../lib/data-check.js';
import { LAST_STEP, STEP_TITLES, draftStorage, emptyDraft } from '../lib/draft.js';
import { estimateFor } from '../lib/settings.js';
import { renderDataStep } from './create/data-step.js';
import { renderPreviewStep } from './create/preview-step.js';
import { renderPublishStep } from './create/publish-step.js';
import { renderSettingsStep } from './create/settings-step.js';
import { renderTemplateStep } from './create/template-step.js';

const SAVE_DEBOUNCE_MS = 400;
const STEP_RENDERERS = [renderTemplateStep, renderDataStep, renderSettingsStep, renderPreviewStep, renderPublishStep];

const settle = (promise) => promise.then((value) => ({ value, error: null })).catch((error) => ({ value: null, error }));

export async function render(root, _params, signal) {
  const storage = draftStorage();
  const restoredText = el('span', { className: 'muted', id: 'draft-restored' });
  const startOver = el('button', { type: 'button', className: 'btn btn-small', id: 'start-over', disabled: true }, 'Start over');
  const stepsBar = el('nav', { className: 'wizard-steps', id: 'wizard-steps', 'aria-label': 'Steps' });
  const body = el('div', { id: 'wizard-body' }, loading());

  root.append(
    el('div', { className: 'page-header' }, el('h2', { className: 'page-title' }, 'Create batch'), el('span', { className: 'page-header-right' }, restoredText, startOver)),
    el('section', { className: 'panel panel-steps' }, stepsBar),
    body,
  );

  const state = {
    draft: emptyDraft(),
    restoredFrom: null,
    dirty: false, // 사용자가 아무것도 바꾸지 않았으면 쓰지 않는다 (빈 draft 저장, 게시 직후의 재저장을 막는다)
    saveTimer: null,
    templates: null,
    templatesError: null,
    pools: null,
    poolsError: null,
    account: null,
    accountError: null,
    stepCleanup: null,
    checkCache: { key: null, data: null, check: null },
  };

  const [loaded, templates, pools, account] = await Promise.all([storage.load(), settle(api.listTemplates()), settle(api.listPools()), settle(api.getAccount())]);
  if (signal.aborted) return undefined;
  if (loaded) {
    storage.markCsvStored(loaded.draft.data);
    state.draft = loaded.draft;
    state.restoredFrom = loaded.savedAt || null;
  }
  state.templates = templates.value;
  state.templatesError = templates.error;
  state.pools = pools.value;
  state.poolsError = pools.error;
  state.account = account.value;
  state.accountError = account.error;

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
  // 대기 중인 저장을 놓치지 않게, 다른 탭으로 가거나 새로고침할 때는 바로 쓴다
  window.addEventListener('pagehide', flush);

  // ── 파생 값 ──
  function selectedTemplate() {
    return (state.templates ?? []).find((t) => t.id === state.draft.templateId) ?? null;
  }
  function currentCheck(template) {
    const { data } = state.draft;
    if (!template || !data) return null;
    // 수 MB 의 CSV 를 훑으므로 placeholder 나 CSV 가 바뀔 때만 다시 계산한다
    const key = template.placeholders.join('\n');
    if (state.checkCache.data === data && state.checkCache.key === key) return state.checkCache.check;
    const check = checkData(template.placeholders, data.columns, data.rows);
    state.checkCache = { key, data, check };
    return check;
  }

  /** 앞 단계의 조건이 깨지면(템플릿 삭제, placeholder 가 맞지 않는 템플릿으로 교체) 그 단계로 돌려보낸다. */
  function reconcile() {
    let changed = false;
    if (state.draft.templateId !== null && selectedTemplate() === null && state.templates !== null) {
      state.draft = { ...state.draft, templateId: null, step: 0 };
      changed = true;
    }
    // 사라진 pool 이 설정에 남아 있으면 게시가 실패하므로 걸러 낸다
    if (state.pools) {
      const known = new Set(state.pools.map((p) => p.id));
      const { requiredPoolIds, excludedPoolIds } = state.draft.settings;
      if (![...requiredPoolIds, ...excludedPoolIds].every((id) => known.has(id))) {
        state.draft = {
          ...state.draft,
          settings: { ...state.draft.settings, requiredPoolIds: requiredPoolIds.filter((id) => known.has(id)), excludedPoolIds: excludedPoolIds.filter((id) => known.has(id)) },
        };
        changed = true;
      }
    }
    const template = selectedTemplate();
    const check = currentCheck(template);
    const maxStep = !template ? 0 : !state.draft.data || !check || check.missingColumns.length > 0 ? 1 : LAST_STEP;
    const step = Math.min(state.draft.step, maxStep);
    if (step !== state.draft.step) {
      state.draft = { ...state.draft, step };
      changed = true;
    }
    if (changed) scheduleSave();
    return { template, check };
  }

  // ── ctx ──
  const ctx = {
    signal,
    get draft() {
      return state.draft;
    },
    get templates() {
      return state.templates;
    },
    get templatesError() {
      return state.templatesError;
    },
    get pools() {
      return state.pools;
    },
    get poolsError() {
      return state.poolsError;
    },
    get account() {
      return state.account;
    },
    get accountError() {
      return state.accountError;
    },
    template: null,
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
    reset({ rerender = true } = {}) {
      if (state.saveTimer) clearTimeout(state.saveTimer);
      state.saveTimer = null;
      state.dirty = false;
      state.restoredFrom = null;
      state.draft = emptyDraft();
      storage.markCsvStored(null);
      void storage.clear();
      if (rerender) renderAll();
    },
    setTemplates(list) {
      state.templates = list;
      state.templatesError = null;
    },
  };

  startOver.addEventListener('click', () => {
    if (!window.confirm('Start over? The template choice, the uploaded CSV and the settings of this draft are discarded. Saved templates are kept.')) return;
    ctx.reset();
  });

  // ── 그리기 ──
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
    const { template, check } = reconcile();
    ctx.template = template;
    ctx.check = check;
    ctx.estimate = estimateFor(state.draft.settings, state.draft.data?.rows.length ?? 0);
    const { draft } = state;
    const hasInput = draft.templateId !== null || draft.data !== null || draft.editor.html !== '' || draft.step > 0;
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

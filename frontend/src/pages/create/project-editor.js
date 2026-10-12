// Project 편집기: /create/project/:projectId/:tab. MTurk 의 Project 화면처럼 탭 세 개로 나눈다.
//   (1) Enter Properties   worker 에게 보이는 설명, 보상과 기간, worker 조건 (properties-form.js)
//   (2) Design Layout      템플릿 HTML 과 미리보기 (layout-tab.js)
//   (3) Preview and Finish 요약, CSV 양식, worker 화면 전체. Finish 로 저장하고 목록으로, 또는 바로 Publish Batch 로 간다
// projectId 가 'new' 면 아직 저장하지 않은 새 Project 다 (New Project 갤러리가 임시 저장에 만들어 둔다). 저장하면 id 가 생긴다.
// 편집은 저장하기 전까지 Project 마다 임시 저장된다 (lib/project-draft.js). 탭을 바꿀 때는 페이지를 다시 그리지 않고 주소만 바꾼다.

import { api, isApiError } from '../../api-client/client.js';
import { el } from '../../components/dom.js';
import { formatBytes, formatDateTime } from '../../components/format.js';
import { errorNotice, loading, muted, notice } from '../../components/notice.js';
import { previewFrame } from '../../components/preview-frame.js';
import { toast } from '../../components/toast.js';
import { formatCents, rewardToCents } from '../../lib/cost.js';
import { hasLayoutErrors, lintLayout } from '../../lib/layout-lint.js';
import { NEW_PROJECT, projectDraftFromTemplate, projectDraftStorage, sameAsSaved, toSaveRequest } from '../../lib/project-draft.js';
import { describeQualifications, estimateFor, validateProperties } from '../../lib/settings.js';
import { navigate } from '../../router.js';
import { createSubnav, descList, downloadCsvTemplate, failureNotice, layoutKindTag, placeholderTags } from './common.js';
import { answerFieldList, previewRow, renderLayoutTab } from './layout-tab.js';
import { flashOnProjects } from './projects.js';
import { propertiesForm } from './properties-form.js';

export const EDITOR_TABS = [
  { key: 'properties', label: 'Enter Properties' },
  { key: 'layout', label: 'Design Layout' },
  { key: 'preview', label: 'Preview and Finish' },
];
const SAVE_DEBOUNCE_MS = 400;
const FINISH_PREVIEW_HEIGHT = 820;

const settle = (promise) => promise.then((value) => ({ value, error: null })).catch((error) => ({ value: null, error }));
/** "$0.05". 숫자가 아니면 적힌 그대로 (Enter Properties 의 검사가 알린다). */
function rewardText(reward) {
  try {
    return formatCents(rewardToCents(reward));
  } catch {
    return String(reward);
  }
}

const plural = (count, unit) => `${count.toLocaleString('en-US')} ${unit}${count === 1 ? '' : 's'}`;

export async function renderProjectEditor(root, params, signal) {
  const storage = projectDraftStorage();
  const key = params.projectId;
  const isNew = key === NEW_PROJECT;
  root.append(loading());

  const [savedResult, poolsResult, restored] = await Promise.all([isNew ? Promise.resolve({ value: null, error: null }) : settle(api.getTemplate(key)), settle(api.listPools()), storage.load(key)]);
  if (signal.aborted) return undefined;
  root.replaceChildren();
  if (savedResult.error) {
    const missing = isApiError(savedResult.error, 'NOT_FOUND');
    root.append(
      el('div', { className: 'page-header' }, el('h2', { className: 'page-title' }, 'Edit project')),
      missing ? notice('error', `Project ${key} does not exist.`, 'It may have been deleted.') : errorNotice(savedResult.error, 'Project'),
      el('p', {}, el('a', { href: '/create' }, 'Back to projects')),
    );
    return undefined;
  }
  const saved = savedResult.value;
  const pools = poolsResult.value;
  let draft = restored?.draft ?? (saved ? projectDraftFromTemplate(saved) : null);
  if (!draft) {
    root.append(
      el('div', { className: 'page-header' }, el('h2', { className: 'page-title' }, 'New project')),
      createSubnav('new'),
      notice('info', 'There is no new project in progress.', 'Choose a template to start one.'),
      el('p', {}, el('a', { href: '/create/new', className: 'btn btn-primary' }, 'Choose a template')),
    );
    return undefined;
  }
  // 임시 저장이 저장본과 같으면 지운다 (저장한 뒤 남은 것)
  if (restored && saved && sameAsSaved(draft, saved)) void storage.clear(key);

  const state = {
    saved,
    draft,
    tab: EDITOR_TABS.some((t) => t.key === params.tab) ? params.tab : 'properties',
    restoredAt: restored && !(saved && sameAsSaved(draft, saved)) ? restored.savedAt : null,
    saveTimer: null,
    saving: false,
    tabCleanup: null,
    form: null,
  };

  // ── 머리 ──
  const title = el('h2', { className: 'page-title', id: 'project-title' });
  const status = el('span', { className: 'muted', id: 'project-status' });
  const discard = el('button', { type: 'button', className: 'btn btn-small', id: 'discard-changes' }, 'Discard changes');
  const saveButton = el('button', { type: 'button', className: 'btn btn-primary btn-small', id: 'save-project' }, 'Save');
  const tabsBar = el('nav', { className: 'wizard-steps editor-tabs', id: 'editor-tabs', 'aria-label': 'Project' });
  const noticeSlot = el('div', { id: 'project-notice' });
  const body = el('div', { id: 'editor-body' });
  root.append(
    el('div', { className: 'page-header' }, title, el('span', { className: 'page-header-right' }, status, discard, saveButton)),
    createSubnav(state.saved ? 'projects' : 'new'),
    el('section', { className: 'panel panel-steps' }, tabsBar),
    noticeSlot,
    body,
  );

  const dirty = () => !state.saved || !sameAsSaved(state.draft, state.saved);

  function renderHeader() {
    const name = state.draft.name.trim() || 'Untitled project';
    title.replaceChildren(state.saved ? 'Edit project: ' : 'New project: ', el('span', { className: 'project-title-name' }, name));
    if (!state.saved) status.textContent = 'Not saved yet';
    else if (dirty()) status.textContent = state.restoredAt ? `Unsaved changes (kept from ${formatDateTime(state.restoredAt)})` : 'Unsaved changes';
    else status.textContent = `Saved ${formatDateTime(state.saved.updatedAt)}`;
    discard.hidden = !state.saved || !dirty();
    saveButton.disabled = state.saving || (Boolean(state.saved) && !dirty());
    saveButton.textContent = state.saving ? 'Saving…' : 'Save';
    tabsBar.replaceChildren(
      ...EDITOR_TABS.map((t, index) =>
        el(
          'button',
          {
            type: 'button',
            className: `wizard-step${t.key === state.tab ? ' active' : ''}`,
            dataset: { tab: t.key },
            'aria-current': t.key === state.tab ? 'step' : null,
            onClick: () => goToTab(t.key),
          },
          el('span', { className: 'wizard-step-number' }, String(index + 1)),
          el('span', { className: 'wizard-step-title' }, t.label),
        ),
      ),
    );
  }

  // ── 편집과 임시 저장 ──
  function flush() {
    if (!state.saveTimer) return;
    clearTimeout(state.saveTimer);
    state.saveTimer = null;
    if (dirty()) void storage.save(key, state.draft);
    else void storage.clear(key);
  }
  function change(patch) {
    state.draft = { ...state.draft, ...patch };
    if (state.saveTimer) clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(flush, SAVE_DEBOUNCE_MS);
    renderHeader();
  }
  window.addEventListener('pagehide', flush);

  function pathFor(tab, id = state.saved?.id ?? key) {
    return `/create/project/${encodeURIComponent(id)}/${tab}`;
  }

  function goToTab(tab, { push = true } = {}) {
    if (tab === state.tab && push) return;
    flush();
    state.tab = tab;
    if (push) history.pushState(null, '', pathFor(tab));
    noticeSlot.replaceChildren();
    renderTab();
    window.scrollTo(0, 0);
  }

  discard.addEventListener('click', () => {
    if (!state.saved || !window.confirm('Discard the unsaved changes and go back to the saved project?')) return;
    clearTimeout(state.saveTimer);
    state.saveTimer = null;
    void storage.clear(key);
    state.draft = projectDraftFromTemplate(state.saved);
    state.restoredAt = null;
    renderTab();
  });

  // ── 저장 ──
  /** 이름, layout, 속성을 검사한다. 문제가 있으면 그 탭으로 가서 알리고 false. */
  function checkBeforeSave() {
    const errors = validateProperties(state.draft.settings, { pools: pools ?? [] });
    if (state.draft.name.trim() === '' || Object.keys(errors).length > 0) {
      if (state.tab !== 'properties') goToTab('properties');
      state.form?.validate();
      noticeSlot.replaceChildren(notice('error', 'Fix the highlighted properties before saving.'));
      return false;
    }
    const lint = lintLayout(state.draft.html);
    if (hasLayoutErrors(lint)) {
      if (state.tab !== 'layout') goToTab('layout');
      noticeSlot.replaceChildren(notice('error', 'The layout has errors. See Checks below the editor.', lint.problems.filter((p) => p.level === 'error')[0].message));
      return false;
    }
    return true;
  }

  /** then: 'stay' | 'list' | 'publish' */
  async function save(then = 'stay') {
    if (state.saving) return;
    if (!checkBeforeSave()) return;
    if (state.saved && !dirty() && then !== 'stay') {
      leave(then, state.saved);
      return;
    }
    state.saving = true;
    renderHeader();
    try {
      const result = await api.saveTemplate(toSaveRequest(state.draft));
      if (signal.aborted) return;
      clearTimeout(state.saveTimer);
      state.saveTimer = null;
      // 메모리 사본은 바로 지워진다. IndexedDB 에서 지우기를 기다리지 않고 다음 화면으로 간다
      void storage.clear(key);
      if (isNew) void storage.clear(NEW_PROJECT);
      state.saved = result;
      state.draft = projectDraftFromTemplate(result);
      state.restoredAt = null;
      state.saving = false;
      if (then === 'stay') {
        toast.success(`Saved "${result.name}".`);
        if (isNew) {
          // 새 Project 는 이제 id 가 있다. 같은 탭의 주소로 바꾸고 그 주소의 편집기로 다시 연다
          navigate(pathFor(state.tab, result.id), { replace: true });
          return;
        }
        renderTab();
        return;
      }
      leave(then, result);
    } catch (error) {
      if (signal.aborted) return;
      state.saving = false;
      renderHeader();
      noticeSlot.replaceChildren(failureNotice('Could not save the project', error));
    }
  }

  function leave(then, project) {
    if (then === 'publish') navigate(`/create/publish/${encodeURIComponent(project.id)}`);
    else {
      flashOnProjects(`Saved "${project.name}". Publish a batch from it with Publish Batch.`, project.id);
      navigate('/create');
    }
  }
  saveButton.addEventListener('click', () => void save('stay'));

  // ── 탭 ──
  const footer = (...buttons) => el('div', { className: 'panel step-footer-panel' }, el('div', { className: 'step-footer' }, ...buttons));
  const navButton = (label, tab, primary = false) => el('button', { type: 'button', className: `btn${primary ? ' btn-primary' : ''}`, dataset: { goto: tab }, onClick: () => goToTab(tab) }, label);

  function renderTab() {
    if (typeof state.tabCleanup === 'function') state.tabCleanup();
    state.tabCleanup = null;
    state.form = null;
    renderHeader();
    if (state.tab === 'properties') {
      const form = propertiesForm({
        name: state.draft.name,
        values: () => state.draft.settings,
        onName: (name) => change({ name }),
        set: (patch) => change({ settings: { ...state.draft.settings, ...patch } }),
        pools,
        poolsError: poolsResult.error,
      });
      state.form = form;
      body.replaceChildren(
        el('section', { className: 'panel step', id: 'tab-properties' }, el('h3', { className: 'panel-title' }, 'Enter Properties'), form.node),
        footer(navButton('Design Layout ›', 'layout', true)),
      );
      return;
    }
    if (state.tab === 'layout') {
      const tab = renderLayoutTab({
        draft: () => state.draft,
        change,
        signal,
        footer: footer(navButton('‹ Enter Properties', 'properties'), navButton('Preview and Finish ›', 'preview', true)),
      });
      state.tabCleanup = tab.cleanup;
      body.replaceChildren(tab.node);
      return;
    }
    const tab = renderFinishTab();
    state.tabCleanup = tab.cleanup;
    body.replaceChildren(tab.node);
  }

  function renderFinishTab() {
    const { draft: d } = state;
    const v = d.settings;
    const lint = lintLayout(d.html);
    const estimate = estimateFor(v, 1);
    const qualifications = describeQualifications(v);
    const poolNames = (ids) => ids.map((id) => (pools ?? []).find((p) => p.id === id)?.name ?? id).join(', ');
    const summary = descList(
      [
        { key: 'name', label: 'Project name', value: d.name.trim() || el('span', { className: 'text-critical' }, 'Not set') },
        { key: 'layout', label: 'Layout', value: [layoutKindTag(d.html), ` ${formatBytes(d.html.length)}, ${plural(lint.questions.length, 'question element')}`] },
        { key: 'title', label: 'Title', value: v.Title, wide: true },
        { key: 'description', label: 'Description', value: v.Description, wide: true },
        { key: 'keywords', label: 'Keywords', value: v.Keywords || el('span', { className: 'muted' }, 'None'), wide: true },
        { key: 'reward', label: 'Reward per assignment', value: rewardText(v.Reward) },
        { key: 'assignments', label: 'Assignments per task', value: String(v.MaxAssignments) },
        { key: 'duration', label: 'Time allotted', value: plural(v.durationMinutes, 'minute') },
        { key: 'lifetime', label: 'Task expires in', value: plural(v.lifetimeDays, 'day') },
        { key: 'auto', label: 'Auto-approve in', value: plural(v.autoApprovalDays, 'day') },
        { key: 'cost', label: 'Cost per task', value: estimate ? `${formatCents(estimate.totalCents)} (reward ${formatCents(estimate.rewardCents)} + ${estimate.feePercent}% fee)` : '–' },
        { key: 'qualifications', label: 'Worker requirements', wide: true, value: qualifications.length > 0 ? qualifications.join('; ') : el('span', { className: 'muted' }, 'Anyone') },
        {
          key: 'pools',
          label: 'Worker pools',
          wide: true,
          value:
            v.requiredPoolIds.length + v.excludedPoolIds.length === 0
              ? el('span', { className: 'muted' }, 'No pool restriction')
              : [v.requiredPoolIds.length > 0 ? `Only ${poolNames(v.requiredPoolIds)}` : null, v.excludedPoolIds.length > 0 ? `Excluding ${poolNames(v.excludedPoolIds)}` : null].filter(Boolean).join('; '),
        },
        { key: 'variables', label: `CSV columns (${lint.placeholders.length})`, wide: true, value: placeholderTags(lint.placeholders) },
      ],
      { id: 'finish-summary' },
    );
    const fieldsBody = el('div', { id: 'finish-fields' }, answerFieldList([]));
    const frame = d.html.trim() ? previewFrame({ html: d.html, row: previewRow(d.sampleRow), height: FINISH_PREVIEW_HEIGHT, onSchema: (fields) => fieldsBody.replaceChildren(answerFieldList(fields)) }) : null;
    const csvButton = el('button', { type: 'button', className: 'btn btn-small', id: 'download-csv-template', disabled: lint.placeholders.length === 0, onClick: () => downloadCsvTemplate(d.name || 'project', d.html, d.sampleRow) }, 'Download CSV template');
    const errors = hasLayoutErrors(lint);
    const finish = el('button', { type: 'button', className: 'btn', id: 'finish', onClick: () => void save('list') }, 'Finish');
    const finishPublish = el('button', { type: 'button', className: 'btn btn-primary', id: 'finish-publish', onClick: () => void save('publish') }, 'Finish and publish a batch');
    const node = el(
      'div',
      { id: 'tab-preview' },
      el(
        'div',
        { className: 'two-col' },
        el('div', { className: 'card' }, el('h4', { className: 'card-title' }, 'Project summary'), summary),
        el(
          'div',
          { className: 'card' },
          el('h4', { className: 'card-title' }, 'Before you publish a batch'),
          el('p', {}, 'Prepare a CSV with one row per task and one column per variable. The template below has the right header and the sample values as its first row.'),
          el('div', { className: 'form-actions inline' }, csvButton),
          el('h4', { className: 'section-title' }, 'Answer fields'),
          fieldsBody,
          errors ? notice('error', 'The layout has errors. Fix them in Design Layout before finishing.') : null,
        ),
      ),
      el(
        'section',
        { className: 'panel', id: 'finish-preview' },
        el('div', { className: 'panel-head' }, el('h3', { className: 'panel-title' }, 'Preview: how workers will see a task')),
        muted('Filled with the sample values from Design Layout. Submit is intercepted and nothing is sent.'),
        frame ? frame.node : muted('The layout is empty.'),
      ),
      footer(navButton('‹ Design Layout', 'layout'), finish, finishPublish),
    );
    return { node, cleanup: () => frame && frame.destroy() };
  }

  // 뒤로/앞으로는 라우터가 이 페이지를 다시 그린다 (임시 저장은 메모리에도 있어 편집이 이어진다)
  renderTab();

  return () => {
    if (typeof state.tabCleanup === 'function') state.tabCleanup();
    window.removeEventListener('pagehide', flush);
    flush();
  };
}

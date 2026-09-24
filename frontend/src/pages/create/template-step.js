// Create (1) Template: 저장된 템플릿을 고르거나, .html 업로드 또는 붙여넣기로 새로 만들거나, 원본 데이터에서 agent 로 만든다.
// ctx 는 pages/create.js 가 만든다: draft, templates, update(change, { rerender }), goTo, setTemplates, signal …

import { agent, api } from '../../api-client/client.js';
import { el } from '../../components/dom.js';
import { formatBytes, formatDateTime } from '../../components/format.js';
import { errorNotice, notice } from '../../components/notice.js';
import { table } from '../../components/table.js';
import { decodeUtf8, parseCsv } from '../../lib/csv.js';
import { applyJobSettings } from '../../lib/settings.js';
import { descList, failureNotice, fetchExample, field, flash, placeholderTags, segmented, stepFooter } from './common.js';
import { mountGenerate } from './generate.js';

export const SAMPLE_TEMPLATE_NAME = 'Sentence-passage relevance (sample)';
export const SAMPLE_TEMPLATE_PATH = '1-task-data/template.html';
// 케이스 스터디의 템플릿 파일은 확장자만 .py 이고 내용은 HTML 이다
const TEMPLATE_FILE_TYPES = '.html,.htm,.txt,.py';
const VISIBLE_PLACEHOLDERS = 6;

const MODES = [
  { value: 'saved', label: 'Use a saved template' },
  { value: 'new', label: 'Upload or paste HTML' },
  { value: 'generate', label: 'Generate from raw data' },
];

/** 편집 중인 내용이 저장본과 같은지 등, 이 단계의 파생 상태 */
function editorState(ctx) {
  const { editor, templateMode, templateId } = ctx.draft;
  const editing = editor.id ? (ctx.templates ?? []).find((t) => t.id === editor.id) ?? null : null;
  const nameMissing = editor.name.trim() === '';
  const htmlMissing = editor.html.trim() === '';
  // 다르면 Next 전에 저장해야 한다 (placeholder 는 저장할 때 계산된다)
  const editorSaved = editing !== null && editing.html === editor.html && editing.name === editor.name.trim();
  const editorSelected = editorSaved && editor.id === templateId;
  const canContinue = ctx.template !== null && (templateMode !== 'new' || editorSelected);
  return { editing, nameMissing, htmlMissing, editorSaved, editorSelected, canContinue };
}

export function renderTemplateStep(ctx) {
  const { draft } = ctx;
  const state = editorState(ctx);
  const noticeSlot = el('div', { id: 'template-notice' });
  let stopGenerate = null;

  const select = (id) => ctx.update({ templateId: id, answerSchema: [] });

  const loadSample = async (button) => {
    button.disabled = true;
    try {
      // example/ 폴더의 파일을 그대로 쓴다. 사람이 직접 올려 보는 파일과 버튼이 채우는 내용이 같다.
      const html = await fetchExample(SAMPLE_TEMPLATE_PATH);
      if (ctx.signal.aborted) return;
      // 시연을 반복해도 같은 템플릿이 계속 쌓이지 않게, 이미 저장된 예시가 있으면 그것을 덮어쓴다
      const existing = (ctx.templates ?? []).find((t) => t.name === SAMPLE_TEMPLATE_NAME);
      ctx.update({
        templateMode: 'new',
        editor: { id: existing?.id ?? null, name: SAMPLE_TEMPLATE_NAME, html },
        // 내용까지 같으면 다시 저장할 것이 없으므로 바로 고른다
        ...(existing && existing.html === html ? { templateId: existing.id, answerSchema: [] } : {}),
      });
    } catch (error) {
      if (ctx.signal.aborted) return;
      button.disabled = false;
      noticeSlot.replaceChildren(failureNotice('Could not load the sample template', error));
    }
  };

  const sampleButton = el('button', { type: 'button', className: 'btn btn-small', id: 'load-sample-template' }, 'Load sample template');
  sampleButton.addEventListener('click', () => void loadSample(sampleButton));

  const body = el('div', { className: 'template-body', dataset: { mode: draft.templateMode } });
  if (draft.templateMode === 'saved') body.append(savedList(ctx, select));
  else if (draft.templateMode === 'new') body.append(editorForm(ctx, state, noticeSlot, select));
  else {
    const holder = el('div', { id: 'generate-mode' });
    body.append(holder);
    stopGenerate = mountGenerate(holder, { signal: ctx.signal, onUseResult: (job) => useJobResult(ctx, job) });
  }

  const selected = ctx.template;
  const summary =
    selected && (draft.templateMode !== 'new' || state.canContinue)
      ? descList(
          [
            { label: 'Selected template', value: el('strong', { id: 'selected-template-name' }, selected.name), wide: true },
            { label: `Placeholders (${selected.placeholders.length})`, value: placeholderTags(selected.placeholders), wide: true },
            { label: 'Size', value: `${formatBytes(selected.html.length)}, updated ${formatDateTime(selected.updatedAt)}`, wide: true },
          ],
          { id: 'selected-template', className: 'desc-single' },
        )
      : null;

  const hint =
    draft.templateMode === 'new' && !state.canContinue
      ? state.editorSaved
        ? 'Click "Use this template" to continue.'
        : 'Save the template to continue.'
      : !selected
        ? 'Choose a template to continue.'
        : undefined;

  const node = el(
    'section',
    { className: 'panel step', id: 'step-template' },
    el('div', { className: 'panel-head' }, el('h3', { className: 'panel-title' }, 'Template'), sampleButton),
    segmented({ id: 'template-mode', options: MODES, value: draft.templateMode, onChange: (mode) => ctx.update({ templateMode: mode }) }),
    noticeSlot,
    body,
    summary,
    stepFooter({ onNext: () => ctx.goTo(1), nextDisabled: !state.canContinue, hint }),
  );
  return { node, cleanup: () => stopGenerate && stopGenerate() };
}

// ── (1) 저장된 템플릿 ─────────────────────────────────────────────────────────

function savedList(ctx, select) {
  const { templates, templatesError, draft } = ctx;
  if (templatesError) return errorNotice(templatesError, 'Templates');
  const columns = [
    {
      title: '',
      width: 40,
      align: 'center',
      render: (t) => el('input', { type: 'radio', name: 'template-choice', value: t.id, checked: t.id === draft.templateId, 'aria-label': `Use ${t.name}` }),
    },
    { title: 'Name', render: (t) => el('div', { className: 'template-name-cell' }, el('strong', {}, t.name), el('span', { className: 'muted small' }, t.id)) },
    {
      title: 'Placeholders',
      render: (t) => {
        const names = t.placeholders ?? [];
        const hidden = names.length - VISIBLE_PLACEHOLDERS;
        return [
          placeholderTags(names.slice(0, VISIBLE_PLACEHOLDERS)),
          hidden > 0 ? el('span', { className: 'muted small', title: names.slice(VISIBLE_PLACEHOLDERS).join(', ') }, ` +${hidden} more`) : null,
        ];
      },
    },
    { title: 'Size', width: 90, align: 'right', render: (t) => formatBytes(t.html.length) },
    { title: 'Updated', width: 150, render: (t) => formatDateTime(t.updatedAt) },
    {
      title: '',
      width: 70,
      render: (t) =>
        el(
          'button',
          {
            type: 'button',
            className: 'btn btn-small btn-link template-edit',
            dataset: { templateId: t.id },
            onClick: (event) => {
              event.stopPropagation();
              ctx.update({ templateMode: 'new', templateId: t.id, answerSchema: [], editor: { id: t.id, name: t.name, html: t.html } });
            },
          },
          'Edit',
        ),
    },
  ];
  return table({
    columns,
    rows: templates ?? [],
    rowKey: (t) => t.id,
    rowAttrs: (t) => ({ className: `template-row${t.id === draft.templateId ? ' selected' : ''}`, dataset: { templateId: t.id }, onClick: () => select(t.id) }),
    empty: 'No saved templates. Upload one, load the sample or generate one from raw data.',
    className: 'template-table',
  });
}

// ── (2) 업로드 / 붙여넣기 ───────────────────────────────────────────────────────

function editorForm(ctx, state, noticeSlot, select) {
  const { editor } = ctx.draft;
  let showErrors = false;
  const setEditor = (change) => ctx.update((current) => ({ editor: { ...current.editor, ...change } }), { rerender: false });

  const nameInput = el('input', { type: 'text', id: 'template-name', value: editor.name, maxlength: 120, placeholder: 'e.g. Chunk-Fact Relevance v2' });
  const fileInput = el('input', { type: 'file', id: 'template-file', accept: TEMPLATE_FILE_TYPES });
  const htmlInput = el('textarea', { id: 'template-html', rows: 14, spellcheck: 'false', placeholder: 'Paste the template HTML here' });
  htmlInput.value = editor.html;
  const nameField = field({ id: 'template-name', label: 'Template name', control: nameInput, required: true, className: 'field-grow' });
  const fileField = field({ id: 'template-file', label: 'From a file', control: fileInput, hint: 'Upload .html (.htm, .txt, .py with HTML inside)' });
  const htmlField = field({
    id: 'template-html',
    label: 'Template HTML',
    control: htmlInput,
    required: true,
    hint: 'One HTML file with the instructions and the question UI. Use ${column} placeholders (MTurk style) or read window.TASK_DATA.',
  });
  const saveButton = el('button', { type: 'button', className: 'btn btn-primary', id: 'template-save' });
  const status = el('span', { className: 'muted small', id: 'template-status' });

  function refresh() {
    const s = editorState(ctx);
    saveButton.textContent = s.editorSaved ? 'Use this template' : ctx.draft.editor.id ? 'Save changes' : 'Save template';
    saveButton.disabled = s.editorSelected;
    status.textContent = s.editorSaved ? 'Saved.' : `${formatBytes(ctx.draft.editor.html.length)}. Placeholders are extracted when you save.`;
    nameField.setError(showErrors && s.nameMissing ? 'Enter a name for the template.' : '');
    htmlField.setError(showErrors && s.htmlMissing ? 'Upload a file or paste the HTML.' : '');
  }

  nameInput.addEventListener('input', () => {
    setEditor({ name: nameInput.value });
    refresh();
  });
  htmlInput.addEventListener('input', () => {
    setEditor({ html: htmlInput.value });
    refresh();
  });
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) return;
    try {
      const html = await file.text();
      if (ctx.signal.aborted) return;
      ctx.update((current) => ({ editor: { id: null, name: current.editor.name.trim() || file.name.replace(/\.[^.]+$/, ''), html } }));
    } catch (error) {
      noticeSlot.replaceChildren(failureNotice(`Could not read ${file.name}`, error));
    }
  });

  saveButton.addEventListener('click', async () => {
    showErrors = true;
    const s = editorState(ctx);
    refresh();
    if (s.nameMissing || s.htmlMissing) return;
    const current = ctx.draft.editor;
    if (s.editorSaved && current.id) {
      // 이미 저장된 내용 그대로다 (저장된 목록에서 다른 템플릿을 골랐다가 돌아온 경우). 다시 저장하지 않고 고르기만 한다
      select(current.id);
      return;
    }
    saveButton.disabled = true;
    saveButton.textContent = 'Saving…';
    try {
      const saved = await api.saveTemplate({ ...(current.id ? { id: current.id } : {}), name: current.name, html: current.html });
      if (ctx.signal.aborted) return;
      ctx.setTemplates([saved, ...(ctx.templates ?? []).filter((t) => t.id !== saved.id)]);
      ctx.update({ templateId: saved.id, answerSchema: [], editor: { id: saved.id, name: saved.name, html: saved.html } });
      flash(document.getElementById('template-notice') ?? noticeSlot, notice('success', `Saved template "${saved.name}".`));
    } catch (error) {
      if (ctx.signal.aborted) return;
      noticeSlot.replaceChildren(failureNotice('Could not save the template', error));
      refresh();
    }
  });

  const editingInfo =
    editor.id && !state.editorSaved
      ? notice(
          'info',
          el('span', {}, 'Editing saved template ', el('code', {}, editor.id), '. Saving overwrites it; batches that were already published keep their own copy.'),
          null,
          el('div', { className: 'notice-actions' }, el('button', { type: 'button', className: 'btn btn-small', id: 'save-as-new', onClick: () => ctx.update((c) => ({ editor: { ...c.editor, id: null } })) }, 'Save as a new template instead')),
        )
      : null;

  refresh();
  return el(
    'div',
    { className: 'template-editor', id: 'template-editor' },
    editingInfo,
    el('div', { className: 'field-row' }, nameField, fileField),
    htmlField,
    el('div', { className: 'form-actions inline' }, saveButton, status),
  );
}

// ── (3) agent job 의 결과 사용 ──────────────────────────────────────────────────

async function fetchJobFile(job, name, as) {
  const response = await fetch(agent.fileUrl(job.id, name));
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
  if (as === 'bytes') return response.arrayBuffer();
  if (as === 'json') return response.json();
  return response.text();
}

/**
 * template.html 은 job 이름으로 저장하고(같은 이름의 템플릿이 있으면 덮어쓴다), hits.csv 는 업로드와 같이 읽고,
 * settings.json 의 값은 Settings 에 얹는다. 끝나면 Data 단계로 간다.
 */
async function useJobResult(ctx, job) {
  const [html, csvBytes, settingsJson] = await Promise.all([fetchJobFile(job, 'template.html', 'text'), fetchJobFile(job, 'hits.csv', 'bytes'), fetchJobFile(job, 'settings.json', 'json')]);
  if (ctx.signal.aborted) return;
  const data = parseCsv(decodeUtf8(csvBytes), 'hits.csv');
  const name = (job.name || job.id).trim();
  const existing = (ctx.templates ?? []).find((t) => t.name === name);
  let saved;
  if (existing && existing.html === html) saved = existing;
  else saved = await api.saveTemplate({ ...(existing ? { id: existing.id } : {}), name, html });
  if (ctx.signal.aborted) return;
  ctx.setTemplates([saved, ...(ctx.templates ?? []).filter((t) => t.id !== saved.id)]);
  const settings = applyJobSettings(ctx.draft.settings, settingsJson, data.columns);
  ctx.update({
    templateMode: 'saved',
    templateId: saved.id,
    editor: { id: saved.id, name: saved.name, html: saved.html },
    data,
    previewRow: 0,
    answerSchema: [],
    settings,
    batchName: '',
    step: 1,
  });
  window.scrollTo(0, 0);
}

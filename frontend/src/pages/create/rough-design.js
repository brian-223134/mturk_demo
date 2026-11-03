// New Project 의 첫 흐름: rough design 고르기 → task 종류 고르기와 예시 미리보기 → HIT 데이터를 넣어 미리 보기 → Publish Batch.
//   /create/new                               가안 고르기. 도형 배치만 보이고, 아래에 다른 시작 방법으로 가는 링크가 있다
//   /create/new/design/:designId(/:taskType)  Vision / Video / Text 고르기. 고른 가안에 예시 자료를 넣어 worker 화면으로 보인다
//   /create/new/design/:designId/:taskType/data  이미 HIT 로 묶인 JSON 을 올리고 binding 으로 칸에 넣어 실제 데이터로 미리 본다.
//       binding 은 요청 문장을 받아 LLM 이 쓰거나(유료 호출, 사용자가 허용해야 한다) 사람이 고친다
// Project 는 미리보기가 끝난 뒤 `Use this design` 에서 저장한다. 올린 데이터는 탭의 메모리에만 두고 서버로 보내지 않는다.
// 가안의 정의는 lib/rough-designs.js, binding 의 검사와 조립은 lib/design-binding.js 에 있다.

import { agent, api } from '../../api-client/client.js';
import { el } from '../../components/dom.js';
import { muted, notice } from '../../components/notice.js';
import { previewFrame } from '../../components/preview-frame.js';
import { adaptBinding, attentionItems, bindingSettings, boundData, boundRow, buildBoundTemplate, checkBinding, dataReader, designForRequest, draftBinding, judgedCounts, requestBinding, summarizeData } from '../../lib/design-binding.js';
import { draftStorage, emptyDraft } from '../../lib/draft.js';
import { readJsonDataFile } from '../../lib/json-data.js';
import { sampleFor, toSaveRequest } from '../../lib/project-draft.js';
import { ROUGH_DESIGNS, SLOT_LABELS, TASK_TYPES, buildDesignTemplate, designDataPath, designPath, findSameProject, roughDesignById, taskContent, taskTypeById } from '../../lib/rough-designs.js';
import { settingsFromProperties } from '../../lib/settings.js';
import { STARTERS } from '../../lib/starters.js';
import { extractPlaceholders } from '../../lib/template.js';
import { navigate } from '../../router.js';
import { createSubnav, failureNotice, field, placeholderTags, segmented, stepFooter } from './common.js';
import { pendingProjectNotice, presetChoice } from './new-project.js';

const STEP_TITLES = ['Rough design', 'Task type and preview', 'HIT data'];
const DESIGN_KEY = 'mturk-console:rough-design';
const PREVIEW_HEIGHT = 880;
const CHECK_DEBOUNCE_MS = 400;
const SAMPLE_ROW_LIMIT = 60 * 1024; // backend 의 sampleRow 상한(64KB)보다 조금 작게

// 올린 HIT 데이터와 고치던 binding. 같은 탭에서 앞 단계에 다녀와도 남는다
let session = null;

const OTHER_STARTS = [
  { choice: () => STARTERS[0].id, title: 'Starter templates', summary: 'Ready-made layouts with sample data' },
  { choice: () => 'upload', title: 'Upload or paste HTML', summary: 'Start from your own template' },
  { choice: () => 'generate', title: 'Generate from raw data', summary: 'Let the agent write the layout and the HIT data' },
];

function readDesign() {
  try {
    return roughDesignById(sessionStorage.getItem(DESIGN_KEY))?.id ?? null;
  } catch {
    return null;
  }
}

function writeDesign(id) {
  try {
    sessionStorage.setItem(DESIGN_KEY, id);
  } catch {
    // 고른 것을 기억하지 못할 뿐이다
  }
}

/** 도형만으로 그린 가안 그림. PPT 에 도형을 놓은 것처럼 칸의 자리와 이름만 보인다. */
export function wireframe(design) {
  const box = (slot) => el('div', { className: `wire-box wire-${slot.startsWith('data') ? 'data' : 'hit'}`, dataset: { slot } }, el('span', {}, SLOT_LABELS[slot]));
  const rows = design.rows.map((row) =>
    el(
      'div',
      { className: 'wire-row', style: { flexGrow: String(row.weight), gridTemplateColumns: row.columns ?? '1fr' } },
      row.slots.map(box),
    ),
  );
  const tabs = design.tabs
    ? el('div', { className: 'wire-tabs' }, Array.from({ length: design.tabs }, (_, index) => el('span', { className: `wire-tab${index === 0 ? ' active' : ''}` }, String(index + 1))))
    : null;
  return el('div', { className: 'wire', 'aria-hidden': 'true' }, el('div', { className: 'wire-instructions' }, 'Instructions'), tabs, rows);
}

function stepsBar(active, designId, taskTypeId) {
  return el(
    'section',
    { className: 'panel panel-steps' },
    el(
      'nav',
      { className: 'wizard-steps', id: 'design-steps', 'aria-label': 'Steps' },
      STEP_TITLES.map((title, index) =>
        el(
          'button',
          {
            type: 'button',
            className: `wizard-step${index === active ? ' active' : index < active ? ' done' : ''}`,
            disabled: index >= active,
            'aria-current': index === active ? 'step' : null,
            onClick: () => {
              if (index === 0) navigate('/create/new');
              else if (index === 1) navigate(designPath(designId, taskTypeId));
            },
          },
          el('span', { className: 'wizard-step-number' }, String(index + 1)),
          el('span', { className: 'wizard-step-title' }, title),
        ),
      ),
    ),
  );
}

export async function renderRoughDesigns(root, signal) {
  let chosen = readDesign();
  const next = el('button', { type: 'button', className: 'btn btn-primary', id: 'design-next', disabled: !chosen }, 'Next');
  next.addEventListener('click', () => chosen && navigate(designPath(chosen)));
  const pendingSlot = el('div', { id: 'pending-project' });
  const cards = ROUGH_DESIGNS.map((design) => {
    const card = el(
      'button',
      {
        type: 'button',
        className: `choice-card design-card${design.id === chosen ? ' active' : ''}`,
        dataset: { design: design.id },
        'aria-pressed': design.id === chosen ? 'true' : 'false',
        onClick: () => {
          chosen = design.id;
          writeDesign(chosen);
          next.disabled = false;
          for (const other of cards) {
            const active = other.dataset.design === chosen;
            other.classList.toggle('active', active);
            other.setAttribute('aria-pressed', active ? 'true' : 'false');
          }
        },
      },
      wireframe(design),
      el('span', { className: 'choice-card-title' }, `${design.letter}. ${design.title}`),
      el('span', { className: 'choice-card-summary' }, design.summary),
    );
    return card;
  });

  root.append(
    el('div', { className: 'page-header' }, el('h2', { className: 'page-title' }, 'Create')),
    createSubnav('new'),
    pendingSlot,
    stepsBar(0),
    el(
      'section',
      { className: 'panel', id: 'rough-designs' },
      el('div', { className: 'panel-head' }, el('h3', { className: 'panel-title' }, 'Select a rough design')),
      muted('Choose how the HIT is arranged on the page. These are layouts only; the next step shows one filled with sample data.'),
      el('div', { className: 'choice-grid design-grid', id: 'design-grid' }, cards),
      el('div', { className: 'step-footer' }, next),
    ),
    el(
      'section',
      { className: 'panel', id: 'other-starts' },
      el('div', { className: 'panel-head' }, el('h3', { className: 'panel-title' }, 'Other ways to start')),
      el(
        'div',
        { className: 'other-starts' },
        OTHER_STARTS.map((start) =>
          el(
            'button',
            {
              type: 'button',
              className: 'choice-card other-start',
              dataset: { other: start.choice() },
              onClick: () => {
                presetChoice(start.choice());
                navigate('/create/new/gallery');
              },
            },
            el('span', { className: 'choice-card-title' }, start.title),
            el('span', { className: 'choice-card-summary' }, start.summary),
          ),
        ),
      ),
    ),
  );
  const pending = await pendingProjectNotice();
  if (pending && !signal.aborted) pendingSlot.replaceChildren(pending);
}

export function renderDesignTask(root, params, signal) {
  const design = roughDesignById(params.designId);
  if (!design) {
    root.append(
      el('div', { className: 'page-header' }, el('h2', { className: 'page-title' }, 'Create')),
      createSubnav('new'),
      notice('error', `There is no rough design called ${params.designId}.`),
      el('p', {}, el('a', { href: '/create/new', className: 'btn btn-primary' }, 'Choose a rough design')),
    );
    return undefined;
  }
  let taskType = taskTypeById(params.taskType);
  let stopPreview = null;

  const previewSlot = el('div', { id: 'design-preview' });
  const footerSlot = el('div', {});

  const typeCards = TASK_TYPES.map((type) =>
    el(
      'button',
      {
        type: 'button',
        className: 'choice-card type-card',
        dataset: { taskType: type.id },
        onClick: () => selectType(type),
      },
      el('span', { className: 'choice-card-title' }, type.title),
      el('span', { className: 'choice-card-summary' }, type.summary),
    ),
  );

  function renderFooter() {
    footerSlot.replaceChildren(
      stepFooter({
        onBack: () => navigate('/create/new'),
        onNext: () => navigate(designDataPath(design.id, taskType.id)),
        nextLabel: 'Next',
        nextId: 'design-to-data',
        nextDisabled: !taskType,
        hint: !taskType ? 'Choose a task type to continue.' : 'Next, put your HIT data into this design.',
      }),
    );
  }

  function renderType() {
    if (typeof stopPreview === 'function') stopPreview();
    stopPreview = null;
    for (const card of typeCards) {
      const active = card.dataset.taskType === taskType?.id;
      card.classList.toggle('active', active);
      card.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
    if (!taskType) {
      previewSlot.replaceChildren();
      renderFooter();
      return;
    }
    const built = buildDesignTemplate(design, taskType);
    const frame = previewFrame({ html: built.html, row: built.sampleRow, height: PREVIEW_HEIGHT });
    stopPreview = frame.destroy;
    previewSlot.replaceChildren(
      el('h4', { className: 'section-title' }, `Preview: ${design.title} with ${taskType.title} samples`),
      muted('This is what workers see, filled with sample data. The next step shows it with your data.'),
      el('div', { className: 'gallery-meta' }, el('span', { className: 'muted' }, 'Sample data columns: '), placeholderTags(extractPlaceholders(built.html))),
      frame.node,
    );
    renderFooter();
  }

  function selectType(type) {
    if (taskType?.id === type.id) return;
    taskType = type;
    // 미리보기만 바꾼다. 주소에 남겨 두어 새로고침해도 고른 종류가 유지되게 한다
    history.replaceState(null, '', designPath(design.id, type.id));
    renderType();
  }

  root.append(
    el('div', { className: 'page-header' }, el('h2', { className: 'page-title' }, 'Create')),
    createSubnav('new'),
    stepsBar(1, design.id, taskType?.id),
    el(
      'section',
      { className: 'panel', id: 'task-type' },
      el('div', { className: 'panel-head' }, el('h3', { className: 'panel-title' }, 'What do workers annotate?')),
      el(
        'div',
        { className: 'design-chosen', id: 'design-chosen' },
        wireframe(design),
        el('div', {}, el('strong', {}, `${design.letter}. ${design.title}`), el('p', { className: 'muted design-chosen-summary' }, design.summary), el('a', { href: '/create/new' }, 'Choose another rough design')),
      ),
      el('div', { className: 'choice-grid type-grid', id: 'type-grid' }, typeCards),
      previewSlot,
      footerSlot,
    ),
  );
  renderType();
  return () => {
    if (typeof stopPreview === 'function') stopPreview();
  };
}

/** Project 를 저장한다. 이름과 layout 이 같은 Project 가 있으면 그것을 쓴다. */
async function saveProject({ name, html, settings, sampleRow }) {
  const templates = await api.listTemplates();
  return findSameProject(templates, name, html) ?? api.saveTemplate(toSaveRequest({ projectId: null, name, html, settings, sampleRow }));
}

function problemList(id, level, title, messages) {
  return messages.length === 0 ? null : notice(level, title, null, el('ul', { className: 'warning-list', id }, messages.map((message) => el('li', {}, message))));
}

/** /create/new/design/:designId/:taskType/data: HIT 데이터를 올리고 binding 으로 가안에 넣어 미리 본다. */
export function renderDesignData(root, params, signal) {
  const design = roughDesignById(params.designId);
  const taskType = taskTypeById(params.taskType);
  if (!design || !taskType) {
    root.append(
      el('div', { className: 'page-header' }, el('h2', { className: 'page-title' }, 'Create')),
      createSubnav('new'),
      notice('error', 'This rough design or task type does not exist.'),
      el('p', {}, el('a', { href: '/create/new', className: 'btn btn-primary' }, 'Choose a rough design')),
    );
    return undefined;
  }

  const state = {
    file: session?.file ?? null, // parseJsonData 의 결과
    reader: session?.reader ?? null,
    binding: null, // 마지막으로 읽은 binding
    text: '',
    check: null,
    hit: 0,
    saving: false,
    nameEdited: false,
    timer: null,
    stopPreview: null,
    prompt: session?.prompt ?? '',
    writing: false,
    undoText: null,
  };
  if (session?.binding) {
    state.binding = { ...adaptBinding(session.binding, design.id), task_type: taskType.id };
    state.text = JSON.stringify(state.binding, null, 2);
  }

  const uploadSlot = el('div', { id: 'hit-data-upload' });
  const errorSlot = el('div', { id: 'hit-data-error' });
  const workSlot = el('div', { id: 'hit-data-work' });
  const footerSlot = el('div', {});
  const nameInput = el('input', { type: 'text', id: 'design-project-name', maxlength: '200' });
  nameInput.addEventListener('input', () => {
    state.nameEdited = true;
    renderFooter();
  });
  const nameField = field({ id: 'design-project-name', label: 'Project name', control: nameInput, hint: 'Saved as a project when you use this design. You can change its properties and layout later.', required: true });

  const defaultName = () => `${(state.check?.design ?? design).title} (${(state.check?.taskType ?? taskType).title})`;
  const problemsSlot = el('div', { id: 'binding-problems' });
  const previewSlot = el('div', { id: 'bound-preview' });
  const editor = el('textarea', { id: 'binding-editor', className: 'binding-editor', rows: 16, spellcheck: 'false', 'aria-label': 'Binding' });

  function remember() {
    session = { file: state.file, reader: state.reader, binding: state.binding, prompt: state.prompt };
  }

  function usable() {
    return state.file && state.check && state.check.errors.length === 0;
  }

  function renderFooter() {
    const name = nameInput.value.trim();
    footerSlot.replaceChildren(
      stepFooter({
        onBack: () => navigate(designPath(design.id, taskType.id)),
        onNext: () => void useDesign(),
        nextLabel: state.saving ? 'Saving…' : 'Use this design',
        nextId: 'use-design',
        nextDisabled: state.saving || !usable() || name === '',
        hint: !state.file ? 'Upload your HIT data to continue.' : !usable() ? 'Fix the binding to continue.' : name === '' ? 'Enter a project name to continue.' : 'Next, review the HIT data and publish the batch.',
      }),
    );
  }

  function renderPreview() {
    if (typeof state.stopPreview === 'function') state.stopPreview();
    state.stopPreview = null;
    if (!usable()) return;
    const { design: currentDesign, taskType: currentType, tabs } = state.check;
    const html = buildBoundTemplate(state.binding, currentDesign, currentType, tabs);
    const row = boundRow(state.binding, currentDesign, currentType, tabs, state.reader, state.hit);
    const frame = previewFrame({ html, row, height: PREVIEW_HEIGHT });
    state.stopPreview = frame.destroy;
    const attention = attentionItems(state.binding, tabs, state.reader, state.hit);
    const counts = judgedCounts(state.binding, currentDesign, currentType, tabs, state.reader, state.hit);
    const checks = [
      attention.length > 0 ? `Attention item(s) in this HIT: ${attention.join(', ')}${counts.attention > 0 ? ` (answers checked in Review: ${counts.attention})` : ''}. Workers cannot tell them apart.` : null,
      counts.reference > 0 ? `Reference labels for this HIT: ${counts.reference}. Review compares answers with them.` : null,
    ].filter(Boolean);
    const hitSelect = el('select', { id: 'bound-hit', 'aria-label': 'HIT' }, Array.from({ length: Math.min(state.reader.rowCount, 200) }, (_, index) => el('option', { value: String(index) }, `HIT ${index + 1}`)));
    hitSelect.value = String(state.hit);
    hitSelect.addEventListener('change', () => {
      state.hit = Number(hitSelect.value);
      renderPreview();
    });
    previewSlot.replaceChildren(
      el(
        'div',
        { className: 'panel-head' },
        el('h4', { className: 'section-title' }, `Preview: ${currentDesign.title} with your data`),
        el('span', { className: 'panel-actions' }, hitSelect, el('span', { className: 'muted small', id: 'bound-hit-count' }, `of ${state.reader.rowCount.toLocaleString('en-US')} HITs`)),
      ),
      checks.length > 0 ? muted(checks.join(' ')) : null,
      frame.node,
    );
  }

  /** 편집기의 글을 읽어 검사하고 화면을 맞춘다. JSON 이 깨져 있으면 직전 미리보기를 지우고 이유를 알린다. */
  function applyText() {
    state.text = editor.value;
    let parsed;
    try {
      parsed = JSON.parse(state.text);
    } catch (error) {
      state.check = { errors: [`The binding is not valid JSON: ${error.message}`], warnings: [], design: null, taskType: null, tabs: 0 };
      showCheck();
      return;
    }
    state.binding = parsed;
    state.check = checkBinding(parsed, state.reader);
    remember();
    showCheck();
  }

  function showCheck() {
    const { errors, warnings } = state.check;
    problemsSlot.replaceChildren(
      ...[problemList('binding-errors', 'error', 'The binding cannot be used yet', errors), problemList('binding-warnings', 'warning', 'Check these before you publish', warnings)].filter(Boolean),
    );
    if (errors.length > 0) previewSlot.replaceChildren();
    renderControls();
    renderPreview();
    if (!state.nameEdited) nameInput.value = defaultName();
    renderFooter();
  }

  /** 가안이나 종류를 바꾼다. 칸의 값은 새 가안으로 옮기고, 주소도 맞춘다. */
  function switchTo(nextDesignId, nextTypeId) {
    if (!state.binding) return;
    state.binding = { ...adaptBinding(state.binding, nextDesignId), task_type: nextTypeId };
    editor.value = JSON.stringify(state.binding, null, 2);
    history.replaceState(null, '', designDataPath(nextDesignId, nextTypeId));
    applyText();
  }

  const controlsSlot = el('div', { className: 'bound-controls', id: 'bound-controls' });
  function renderControls() {
    const current = state.binding ?? {};
    controlsSlot.replaceChildren(
      el('span', { className: 'muted' }, 'Rough design'),
      segmented({ id: 'bound-design', options: ROUGH_DESIGNS.map((d) => ({ value: d.id, label: `${d.letter}. ${d.title}` })), value: current.design, onChange: (value) => switchTo(value, current.task_type) }),
      el('span', { className: 'muted' }, 'Task type'),
      segmented({ id: 'bound-type', options: TASK_TYPES.map((t) => ({ value: t.id, label: t.title })), value: current.task_type, onChange: (value) => switchTo(current.design, value) }),
    );
  }

  // ── LLM 에 binding 쓰게 하기 ──
  const promptInput = el('textarea', { id: 'binding-prompt', rows: 3, placeholder: 'What should workers judge? For example: for each chunk, check every atomic fact the chunk supports.', 'aria-label': 'What workers should judge' });
  const allowApi = el('input', { type: 'checkbox', id: 'binding-allow-api' });
  const writeButton = el('button', { type: 'button', className: 'btn btn-primary btn-small', id: 'write-binding' }, 'Write the binding');
  const undoButton = el('button', { type: 'button', className: 'btn btn-small', id: 'undo-binding', hidden: true }, 'Undo');
  const agentStatus = el('div', { className: 'muted small', id: 'binding-agent-status' });
  const agentError = el('div', { id: 'binding-agent-error' });
  const agentPanel = el(
    'div',
    { className: 'binding-agent', id: 'binding-agent' },
    el('label', { for: 'binding-prompt' }, 'What should workers judge?'),
    promptInput,
    el('div', { className: 'binding-agent-actions' }, el('label', { className: 'check-label' }, allowApi, ' Allow API calls (uses credits)'), writeButton, undoButton),
    agentStatus,
    agentError,
  );
  promptInput.addEventListener('input', () => {
    state.prompt = promptInput.value;
    remember();
    refreshAgent();
  });
  allowApi.addEventListener('change', () => refreshAgent());
  let agentInfo = null; // /api/agent/models. 못 받으면 LLM 을 쓸 수 없다 (prototype 의 mock API)

  function refreshAgent() {
    writeButton.disabled = state.writing || !agentInfo?.api_allowed || !allowApi.checked || promptInput.value.trim() === '';
    writeButton.textContent = state.writing ? 'Writing…' : 'Write the binding';
  }

  function loadAgentInfo() {
    agent.listModels().then(
      (models) => {
        if (signal.aborted) return;
        agentInfo = models;
        allowApi.disabled = !models.api_allowed;
        if (!models.api_allowed) agentStatus.textContent = 'LLM calls are disabled on this server. Set AGENT_ALLOW_API=1 in environment/.env, or edit the binding by hand.';
        else agentStatus.textContent = `Model config: ${models.binding_model}. The file stays here; only its structure and a few cut samples are sent.`;
        refreshAgent();
      },
      () => {
        if (signal.aborted) return;
        agentStatus.textContent = 'The agent is not available on this server. Edit the binding by hand.';
        allowApi.disabled = true;
        refreshAgent();
      },
    );
  }

  async function writeWithAgent() {
    if (state.writing) return;
    const current = state.binding ?? {};
    const currentDesign = roughDesignById(current.design) ?? design;
    state.writing = true;
    agentError.replaceChildren();
    refreshAgent();
    agentStatus.textContent = 'Asking the model. This can take a minute or two.';
    try {
      const result = await requestBinding({
        send: (body) => agent.createBinding(body),
        check: (binding) => checkBinding(binding, state.reader),
        request: { design: designForRequest(currentDesign), task_type: current.task_type ?? taskType.id, prompt: promptInput.value.trim(), data: summarizeData(state.reader), allow_api: true },
      });
      if (signal.aborted) return;
      state.undoText = editor.value;
      undoButton.hidden = false;
      editor.value = JSON.stringify(result.binding, null, 2);
      applyText();
      const cost = typeof result.usage.cost === 'number' ? `, $${result.usage.cost.toFixed(4)}` : '';
      agentStatus.textContent = `Written by ${result.model?.model ?? 'the model'} (${result.model?.provider_tag ?? 'any provider'}): ${result.attempts} attempt(s)${cost}.`;
      if (result.errors.length > 0) agentError.replaceChildren(notice('warning', 'The model could not fix every problem', 'Its last answer is in the editor. Fix the problems listed below by hand, or ask again.'));
    } catch (error) {
      if (signal.aborted) return;
      agentStatus.textContent = '';
      agentError.replaceChildren(failureNotice('Could not write the binding', error));
    } finally {
      state.writing = false;
      refreshAgent();
    }
  }

  writeButton.addEventListener('click', () => void writeWithAgent());
  undoButton.addEventListener('click', () => {
    if (state.undoText === null) return;
    editor.value = state.undoText;
    state.undoText = null;
    undoButton.hidden = true;
    applyText();
  });

  function renderWork() {
    if (!state.file) {
      workSlot.replaceChildren();
      renderFooter();
      return;
    }
    const bindingFile = el('input', { type: 'file', id: 'binding-file', accept: '.json,application/json', className: 'dropzone-input' });
    bindingFile.addEventListener('change', async () => {
      const file = bindingFile.files[0];
      bindingFile.value = '';
      if (!file) return;
      editor.value = await file.text();
      applyText();
    });
    editor.value = state.text;
    promptInput.value = state.prompt;
    refreshAgent();
    workSlot.replaceChildren(
      controlsSlot,
      agentPanel,
      el(
        'div',
        { className: 'binding-split' },
        el(
          'div',
          { className: 'binding-column' },
          el('div', { className: 'panel-head' }, el('h4', { className: 'section-title' }, 'Binding'), el('span', { className: 'panel-actions' }, el('label', { className: 'btn btn-small', for: 'binding-file' }, 'Upload binding', bindingFile))),
          muted('Says which data goes into which slot. Use a column name, then [i] for the current item when the HIT repeats. You can edit what the model wrote.'),
          editor,
          problemsSlot,
        ),
        el('div', { className: 'binding-column' }, previewSlot),
      ),
      nameField,
    );
    applyText();
  }

  async function readData(file) {
    errorSlot.replaceChildren();
    let parsed;
    try {
      parsed = await readJsonDataFile(file);
    } catch (error) {
      if (!signal.aborted) errorSlot.replaceChildren(failureNotice(`Could not read ${file.name}`, error));
      return;
    }
    if (signal.aborted) return;
    state.file = parsed;
    state.reader = dataReader(parsed);
    state.hit = 0;
    state.binding = draftBinding(design.id, taskType.id, state.reader);
    state.text = JSON.stringify(state.binding, null, 2);
    renderUpload();
    renderWork();
  }

  function renderUpload() {
    const fileInput = el('input', { type: 'file', id: 'data-file', accept: '.json,application/json', className: 'dropzone-input' });
    fileInput.addEventListener('change', () => {
      const file = fileInput.files[0];
      fileInput.value = '';
      if (file) void readData(file);
    });
    const dropzone = el(
      'label',
      { className: `dropzone${state.file ? ' dropzone-compact' : ''}`, id: 'data-dropzone', for: 'data-file' },
      fileInput,
      state.file
        ? el('span', { className: 'dropzone-text' }, `${state.file.fileName}: ${state.file.rows.length.toLocaleString('en-US')} HITs, ${state.file.columns.length} columns. Drop another JSON file here, or click to replace it.`)
        : [el('span', { className: 'dropzone-text' }, 'Drop your HIT data here, or click to choose a JSON file'), el('span', { className: 'muted small' }, 'A JSON array with one object per HIT. It stays in this browser tab.')],
    );
    for (const type of ['dragenter', 'dragover']) {
      dropzone.addEventListener(type, (event) => {
        event.preventDefault();
        dropzone.classList.add('dragging');
      });
    }
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragging'));
    dropzone.addEventListener('drop', (event) => {
      event.preventDefault();
      dropzone.classList.remove('dragging');
      const file = event.dataTransfer?.files?.[0];
      if (file) void readData(file);
    });
    uploadSlot.replaceChildren(dropzone);
  }

  async function useDesign() {
    if (state.saving || !usable()) return;
    const name = nameInput.value.trim();
    if (name === '') return;
    state.saving = true;
    errorSlot.replaceChildren();
    renderFooter();
    const { design: currentDesign, taskType: currentType, tabs } = state.check;
    const html = buildBoundTemplate(state.binding, currentDesign, currentType, tabs);
    const data = boundData(state.binding, currentDesign, currentType, tabs, state.reader, state.file.fileName);
    const sample = sampleFor(html, data.rows[0] ?? {});
    const properties = settingsFromProperties(taskContent(currentType).properties);
    const settings = { ...properties, ...bindingSettings(state.binding) };
    try {
      const project = await saveProject({ name, html, settings: properties, sampleRow: JSON.stringify(sample).length <= SAMPLE_ROW_LIMIT ? sample : {} });
      if (signal.aborted) return;
      // 메모리 사본으로 Publish Batch 에 넘긴다 (IndexedDB 에 다 쓰기를 기다리지 않는다)
      void draftStorage().save({ ...emptyDraft(), templateId: project.id, data, settings });
      navigate(`/create/publish/${encodeURIComponent(project.id)}`);
    } catch (error) {
      if (signal.aborted) return;
      state.saving = false;
      errorSlot.replaceChildren(failureNotice('Could not save the project', error));
      renderFooter();
    }
  }

  /** 데이터 없이 예시 layout 만 Project 로 저장하고 나중에 Upload JSON 으로 올린다. */
  async function saveWithoutData() {
    const built = buildDesignTemplate(design, taskType);
    errorSlot.replaceChildren();
    try {
      const project = await saveProject({ name: built.name, html: built.html, settings: built.properties, sampleRow: built.sampleRow });
      if (!signal.aborted) navigate(`/create/publish/${encodeURIComponent(project.id)}`);
    } catch (error) {
      if (!signal.aborted) errorSlot.replaceChildren(failureNotice('Could not save the project', error));
    }
  }

  editor.addEventListener('input', () => {
    clearTimeout(state.timer);
    state.timer = setTimeout(applyText, CHECK_DEBOUNCE_MS);
  });

  root.append(
    el('div', { className: 'page-header' }, el('h2', { className: 'page-title' }, 'Create')),
    createSubnav('new'),
    stepsBar(2, design.id, taskType.id),
    el(
      'section',
      { className: 'panel', id: 'hit-data' },
      el('div', { className: 'panel-head' }, el('h3', { className: 'panel-title' }, 'Put your HIT data into the design'), el('span', { className: 'panel-actions' }, el('button', { type: 'button', className: 'btn btn-small btn-link', id: 'save-without-data', onClick: () => void saveWithoutData() }, 'Save the sample layout without data'))),
      uploadSlot,
      errorSlot,
      workSlot,
      footerSlot,
    ),
  );
  renderUpload();
  loadAgentInfo();
  renderWork();
  if (!state.file) renderFooter();
  return () => {
    clearTimeout(state.timer);
    if (typeof state.stopPreview === 'function') state.stopPreview();
  };
}

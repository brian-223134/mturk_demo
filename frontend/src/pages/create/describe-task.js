// New Project 의 "Describe your task": 가안(rough design)을 고르지 않고, Requester 가 문장 하나로 HIT 를 만든다.
//   /create/new/describe
//   1. HIT 데이터(JSON)를 올리고, 무엇을 어디에 보이고 어떤 문항을 물을지 문장으로 적는다
//   2. Agent 가 계약(보여 줄 값, 문항 몇 개든·모든 종류, 문항별 대조 기준과 attention)을 쓴다 → lib/task-contract.js 가 검사하고 틀리면 다시 묻는다
//   3. 코드가 계약으로 기본 페이지를 만든다. 원하면 Agent 가 같은 문장의 배치·표현대로 페이지를 다시 쓰고 lib/html-harness.js 가 검사한다
//   4. Use this task: Project 를 저장하고 게시용 데이터와 대조 기준·attention 설정을 Publish Batch 로 넘긴다
// 두 Agent 호출은 유료이며 Allow API calls 를 켜야 한다. 올린 데이터는 탭의 메모리에만 두고, Agent 에는 구조와 잘린 표본만 간다.

import { agent } from '../../api-client/client.js';
import { el } from '../../components/dom.js';
import { muted, notice } from '../../components/notice.js';
import { previewFrame } from '../../components/preview-frame.js';
import { dataReader, summarizeData } from '../../lib/design-binding.js';
import { draftStorage, emptyDraft } from '../../lib/draft.js';
import { checkAgentHtml, pageRequest, requestHtml } from '../../lib/html-harness.js';
import { readJsonDataFile } from '../../lib/json-data.js';
import { sampleFor } from '../../lib/project-draft.js';
import { taskContent, taskTypeById } from '../../lib/rough-designs.js';
import { settingsFromProperties } from '../../lib/settings.js';
import { checkContract, contractOutline, contractSettings, contractTaskType, harnessContract, requestContract } from '../../lib/task-contract.js';
import { navigate } from '../../router.js';
import { createSubnav, failureNotice, field, stepFooter } from './common.js';
import { saveProject } from './rough-design.js';

const PREVIEW_HEIGHT = 880;
const CHECK_DEBOUNCE_MS = 400;
const SAMPLE_ROW_LIMIT = 60 * 1024;
const TASK_PLACEHOLDER = 'For example: show the question in bold at the top, then the passage. Ask whether the passage answers the question (Yes / Partly / No), then a checklist of problems (Off topic, Outdated, Too vague), and an optional comment box. gold has the answers to the first question.';
const PAGE_PLACEHOLDER = 'For example: put the passage on the left and the questions on the right.';

// 같은 탭에서 다른 화면에 다녀와도 남는 것
let session = null;

const typeLabel = { choice: 'Pick one', likert: 'Score', checklist: 'Check all that apply', 'item-choice': 'One answer per item', text: 'Written answer' };

function problemList(id, level, title, messages) {
  return messages.length === 0 ? null : notice(level, title, null, el('ul', { className: 'warning-list', id }, messages.map((message) => el('li', {}, message))));
}

/** 계약 요약 표: Agent 가 정한 값과 문항을 Requester 가 읽고 확인한다. */
function outlineNode(contract) {
  const outline = contractOutline(contract);
  const tag = (text, className = '') => el('span', { className: `tag ${className}`.trim() }, text);
  return el(
    'div',
    { className: 'task-outline', id: 'task-outline' },
    outline.itemLabel ? el('p', { className: 'muted small' }, `Each HIT repeats for every item: ${outline.itemLabel}.`) : null,
    el('h4', { className: 'section-title' }, 'What workers see'),
    el(
      'table',
      { className: 'table task-outline-table', id: 'task-values' },
      el('thead', {}, el('tr', {}, el('th', {}, 'Value'), el('th', {}, 'From your data'), el('th', {}, 'Shown'))),
      el('tbody', {}, outline.values.map((value) => el('tr', {}, el('td', {}, value.label, value.kind === 'text' ? null : [' ', tag(value.kind)]), el('td', {}, el('code', {}, value.from)), el('td', {}, value.perItem ? 'for each item' : 'once')))),
    ),
    el('h4', { className: 'section-title' }, 'What workers answer'),
    el(
      'table',
      { className: 'table task-outline-table', id: 'task-questions' },
      el('thead', {}, el('tr', {}, el('th', {}, 'Question'), el('th', {}, 'Answers'), el('th', {}, 'Checks'))),
      el(
        'tbody',
        {},
        outline.questions.map((question) =>
          el(
            'tr',
            { dataset: { question: question.name } },
            el('td', {}, el('strong', {}, question.header), el('div', { className: 'muted small' }, `${typeLabel[question.type] ?? question.type}${question.perItem ? ', for each item' : ''} · answer name ${question.name}`)),
            el('td', {}, question.answers),
            el('td', {}, question.compared ? tag('Compared with your labels', 'tag-ok') : null, question.attention ? [' ', tag('Attention check')] : null),
          ),
        ),
      ),
    ),
  );
}

export function renderDescribeTask(root, signal) {
  const state = {
    file: session?.file ?? null,
    reader: session?.reader ?? null,
    prompt: session?.prompt ?? '',
    contract: session?.contract ?? null,
    contractText: session?.contract ? JSON.stringify(session.contract, null, 2) : '',
    contractMessage: session?.contractMessage ?? null,
    contractMeta: session?.contractMeta ?? null,
    check: null,
    harness: null,
    html: session?.html ?? null, // Agent 가 다시 쓴 페이지. 없으면 기본 페이지
    pageMessage: session?.pageMessage ?? null,
    pagePrompt: session?.pagePrompt ?? '',
    pageNote: null,
    writing: false,
    arranging: false,
    hit: 0,
    saving: false,
    nameEdited: false,
    timer: null,
    stopPreview: null,
  };
  let agentInfo = null;

  const uploadSlot = el('div', { id: 'task-data-upload' });
  const errorSlot = el('div', { id: 'task-data-error' });
  const contractSlot = el('div', { id: 'task-contract' });
  const pageSlot = el('div', { id: 'task-page' });
  const footerSlot = el('div', {});

  const promptInput = el('textarea', { id: 'task-prompt', rows: 5, placeholder: TASK_PLACEHOLDER });
  const allowApi = el('input', { type: 'checkbox', id: 'task-allow-api' });
  const writeButton = el('button', { type: 'button', className: 'btn btn-primary btn-small', id: 'write-task' });
  const agentStatus = el('div', { className: 'muted small', id: 'task-agent-status' });
  const agentError = el('div', { id: 'task-agent-error' });
  const editor = el('textarea', { id: 'contract-editor', className: 'binding-editor', rows: 16, spellcheck: 'false', 'aria-label': 'Task contract' });
  const pagePrompt = el('textarea', { id: 'page-prompt', rows: 2, placeholder: PAGE_PLACEHOLDER });
  const arrangeButton = el('button', { type: 'button', className: 'btn btn-primary btn-small', id: 'arrange-page' });
  const plainButton = el('button', { type: 'button', className: 'btn btn-small btn-link', id: 'plain-page' }, 'Use the plain layout');
  const pageStatus = el('div', { className: 'muted small', id: 'page-agent-status' });
  const pageError = el('div', { id: 'page-agent-error' });
  const nameInput = el('input', { type: 'text', id: 'task-project-name', maxlength: '200' });
  nameInput.addEventListener('input', () => {
    state.nameEdited = true;
    renderFooter();
  });

  function remember() {
    session = { file: state.file, reader: state.reader, prompt: state.prompt, contract: state.contract, contractMessage: state.contractMessage, contractMeta: state.contractMeta, html: state.html, pageMessage: state.pageMessage, pagePrompt: state.pagePrompt };
  }

  const usable = () => Boolean(state.file && state.harness);
  const currentHtml = () => state.html ?? state.harness?.html ?? '';

  function refreshButtons() {
    const allowed = Boolean(agentInfo?.api_allowed && allowApi.checked);
    writeButton.disabled = state.writing || state.arranging || !state.file || !allowed || promptInput.value.trim() === '';
    writeButton.textContent = state.writing ? 'Writing…' : state.contract ? 'Write the task again' : 'Write the task';
    arrangeButton.disabled = state.writing || state.arranging || !state.harness || !allowed || (pagePrompt.value.trim() === '' && promptInput.value.trim() === '');
    arrangeButton.textContent = state.arranging ? 'Arranging…' : 'Arrange the page';
    plainButton.hidden = state.html === null;
    editor.readOnly = state.writing;
  }

  function renderFooter() {
    const name = nameInput.value.trim();
    footerSlot.replaceChildren(
      stepFooter({
        onBack: () => navigate('/create/new'),
        onNext: () => void useTask(),
        nextLabel: state.saving ? 'Saving…' : 'Use this task',
        nextId: 'use-task',
        nextDisabled: state.saving || !usable() || name === '',
        hint: !state.file ? 'Upload your HIT data to continue.' : !state.contract ? 'Describe the task and let the model write it, or paste a task contract below.' : !usable() ? 'Fix the task to continue.' : name === '' ? 'Enter a project name to continue.' : 'Next, review the HIT data and publish the batch.',
      }),
    );
  }

  // ── 계약 ──
  function applyContract({ fromEditor = false } = {}) {
    if (fromEditor) {
      try {
        state.contract = JSON.parse(editor.value);
      } catch (error) {
        state.check = { errors: [`The task contract is not valid JSON: ${error.message}`], warnings: [], tabs: 0 };
        state.harness = null;
        renderContract();
        return;
      }
    }
    state.contractText = JSON.stringify(state.contract, null, 2);
    state.check = state.contract && state.reader ? checkContract(state.contract, state.reader) : null;
    state.harness = state.check && state.check.errors.length === 0 ? harnessContract(state.contract, state.reader) : null;
    // 계약이 바뀌면 다시 쓴 페이지가 새 계약을 지키는지 다시 본다. 지키지 못하면 기본 페이지로 돌아간다
    state.pageNote = null;
    if (state.html && state.harness && checkAgentHtml(state.html, state.harness).errors.length > 0) {
      state.html = null;
      state.pageMessage = null;
      state.pageNote = 'The task changed, so the arranged page no longer fits it. The plain layout is shown; arrange the page again if you like.';
    }
    remember();
    renderContract();
  }

  function renderContract() {
    if (!state.file) {
      contractSlot.replaceChildren();
      pageSlot.replaceChildren();
      renderFooter();
      return;
    }
    if (!state.contract && !state.check) {
      contractSlot.replaceChildren(
        el('details', { className: 'binding-json', id: 'contract-json' }, el('summary', {}, 'Paste a task contract instead (advanced)'), muted('The same JSON the model writes. See agent/contract_reference.md for the format.'), editor),
      );
      pageSlot.replaceChildren();
      renderFooter();
      return;
    }
    const { errors = [], warnings = [] } = state.check ?? {};
    if (document.activeElement !== editor) editor.value = state.contractText;
    contractSlot.replaceChildren(
      el(
        'section',
        { className: 'panel', id: 'task-contract-panel' },
        el('div', { className: 'panel-head' }, el('h3', { className: 'panel-title' }, 'The task')),
        state.contractMessage ? el('div', { className: 'binding-bubble binding-bubble-model', id: 'task-message' }, el('p', {}, state.contractMessage), state.contractMeta ? el('div', { className: 'muted small' }, state.contractMeta) : null) : null,
        problemList('task-errors', 'error', 'The task cannot be used yet', errors),
        problemList('task-warnings', 'warning', 'Check these before you publish', warnings),
        state.contract && errors.length === 0 ? outlineNode(state.contract) : null,
        el('details', { className: 'binding-json', id: 'contract-json' }, el('summary', {}, 'Edit as JSON (advanced)'), muted('Change values, questions, options, answer keys or attention checks here. The page updates as you type.'), editor),
      ),
    );
    renderPage();
    if (!state.nameEdited && state.contract?.instructions) nameInput.value = state.file ? `${state.file.fileName.replace(/\.json$/i, '')} task` : 'New task';
    refreshButtons();
    renderFooter();
  }

  // ── 페이지 ──
  function renderPage() {
    if (typeof state.stopPreview === 'function') state.stopPreview();
    state.stopPreview = null;
    if (!state.harness) {
      pageSlot.replaceChildren();
      return;
    }
    const rows = state.harness.data.rows;
    state.hit = Math.min(state.hit, rows.length - 1);
    const frame = previewFrame({ html: currentHtml(), row: rows[state.hit], height: PREVIEW_HEIGHT });
    state.stopPreview = frame.destroy;
    const hitSelect = el('select', { id: 'task-hit', 'aria-label': 'HIT' }, Array.from({ length: Math.min(rows.length, 200) }, (_, index) => el('option', { value: String(index) }, `HIT ${index + 1}`)));
    hitSelect.value = String(state.hit);
    hitSelect.addEventListener('change', () => {
      state.hit = Number(hitSelect.value);
      renderPage();
    });
    const reference = JSON.parse(rows[state.hit].slot_reference ?? '{}');
    const attention = JSON.parse(rows[state.hit].slot_attention ?? '{}');
    const checks = [
      Object.keys(attention).length > 0 ? `This HIT has ${Object.keys(attention).length} attention answer(s). Workers cannot tell them apart.` : null,
      Object.keys(reference).length > 0 ? `Reference labels for this HIT: ${Object.keys(reference).length}. Review compares answers with them.` : null,
    ].filter(Boolean);
    if (pagePrompt.value === '' && state.pagePrompt !== '') pagePrompt.value = state.pagePrompt;
    pageSlot.replaceChildren(
      el(
        'section',
        { className: 'panel', id: 'task-page-panel' },
        el('div', { className: 'panel-head' }, el('h3', { className: 'panel-title' }, state.html ? 'The page, arranged by the model' : 'The page'), el('span', { className: 'panel-actions' }, hitSelect, el('span', { className: 'muted small' }, `of ${rows.length.toLocaleString('en-US')} HITs`))),
        el(
          'div',
          { className: 'binding-agent', id: 'page-agent' },
          el('label', { for: 'page-prompt' }, 'How should the page look?'),
          muted('Leave this empty to arrange the page as your description says. The model only moves and styles things: every value and question stays, and answers are never shown.'),
          pagePrompt,
          el('div', { className: 'binding-agent-actions' }, plainButton, arrangeButton),
          pageStatus,
          pageError,
        ),
        state.pageNote ? notice('warning', state.pageNote) : null,
        state.pageMessage ? el('div', { className: 'binding-bubble binding-bubble-model', id: 'page-message' }, el('p', {}, state.pageMessage)) : null,
        checks.length > 0 ? muted(checks.join(' ')) : null,
        frame.node,
      ),
    );
    refreshButtons();
  }

  // ── Agent 호출 ──
  function loadAgentInfo() {
    agent.listModels().then(
      (models) => {
        if (signal.aborted) return;
        agentInfo = models;
        allowApi.disabled = !models.api_allowed;
        agentStatus.textContent = models.api_allowed
          ? `Model config: ${models.binding_model}. The file stays here; only its structure and a few cut samples are sent.`
          : 'LLM calls are disabled on this server. Set AGENT_ALLOW_API=1 in environment/.env, or paste a task contract by hand.';
        refreshButtons();
      },
      () => {
        if (signal.aborted) return;
        agentStatus.textContent = 'The agent is not available on this server. Paste a task contract by hand.';
        allowApi.disabled = true;
        refreshButtons();
      },
    );
  }

  const metaOf = (result) => `${result.model?.model ?? 'the model'} (${result.model?.served_by ?? 'any provider'}): ${result.attempts} attempt(s)${typeof result.usage?.cost === 'number' ? `, $${result.usage.cost.toFixed(4)}` : ''}`;

  async function writeTask() {
    if (state.writing || !state.reader) return;
    state.writing = true;
    agentError.replaceChildren();
    agentStatus.textContent = 'Asking the model to write the task. This can take a minute.';
    refreshButtons();
    let model = null;
    try {
      const result = await requestContract({
        send: async (body) => {
          const reply = await agent.createContract(body);
          model = reply.model;
          return reply;
        },
        check: (contract) => checkContract(contract, state.reader),
        request: { request: promptInput.value.trim(), data: summarizeData(state.reader), allow_api: true },
      });
      if (signal.aborted) return;
      const meta = metaOf({ ...result, model });
      agentStatus.textContent = `Last answer from ${meta}.`;
      if (result.cannot) {
        state.contractMessage = result.message ?? 'The model could not write this task.';
        state.contractMeta = meta;
      } else {
        state.contract = result.contract;
        state.contractMessage = result.message;
        state.contractMeta = meta;
        state.html = null; // 새 과제이므로 페이지도 처음부터다
        state.pageMessage = null;
        if (result.errors.length > 0) state.contractMessage = `${result.message ?? ''} The model could not fix every problem; fix them below or write the task again.`.trim();
      }
      applyContract();
    } catch (error) {
      if (!signal.aborted) {
        agentStatus.textContent = '';
        agentError.replaceChildren(failureNotice('Could not write the task', error));
      }
    } finally {
      state.writing = false;
      refreshButtons();
    }
  }

  async function arrangePage() {
    if (state.arranging || !state.harness) return;
    state.arranging = true;
    pageError.replaceChildren();
    pageStatus.textContent = 'Asking the model to arrange the page.';
    refreshButtons();
    const wish = pagePrompt.value.trim() || promptInput.value.trim();
    let model = null;
    try {
      const harness = state.harness;
      const result = await requestHtml({
        send: async (body) => {
          const reply = await agent.createPage(body);
          model = reply.model;
          return reply;
        },
        check: (html) => checkAgentHtml(html, harness),
        request: { ...pageRequest(harness, wish, contractTaskType(state.contract)), allow_api: true },
      });
      if (signal.aborted) return;
      const meta = metaOf({ ...result, model });
      pageStatus.textContent = `Last answer from ${meta}.`;
      if (result.cannot || result.errors.length > 0) {
        // 검사를 통과하지 못한 페이지는 쓰지 않는다
        pageError.replaceChildren(
          notice('warning', result.cannot ? 'The model could not arrange the page this way' : 'The arranged page broke the task, so it was not used', null, el('ul', { className: 'warning-list' }, [result.message, ...result.errors].filter(Boolean).map((text) => el('li', {}, text)))),
        );
      } else {
        state.html = result.html;
        state.pageMessage = result.message;
        state.pagePrompt = pagePrompt.value;
        state.pageNote = null;
        remember();
      }
      renderPage();
    } catch (error) {
      if (!signal.aborted) {
        pageStatus.textContent = '';
        pageError.replaceChildren(failureNotice('Could not arrange the page', error));
      }
    } finally {
      state.arranging = false;
      refreshButtons();
    }
  }

  function usePlainLayout() {
    state.html = null;
    state.pageMessage = null;
    remember();
    renderPage();
  }

  async function useTask() {
    if (state.saving || !usable()) return;
    const name = nameInput.value.trim();
    if (name === '') return;
    state.saving = true;
    errorSlot.replaceChildren();
    renderFooter();
    const html = currentHtml();
    const data = { ...state.harness.data, fileName: state.file.fileName };
    const sample = sampleFor(html, data.rows[0] ?? {});
    const properties = settingsFromProperties(taskContent(taskTypeById(contractTaskType(state.contract))).properties);
    const settings = { ...properties, ...contractSettings(state.contract) };
    try {
      const project = await saveProject({ name, html, settings: properties, sampleRow: JSON.stringify(sample).length <= SAMPLE_ROW_LIMIT ? sample : {} });
      if (signal.aborted) return;
      void draftStorage().save({ ...emptyDraft(), templateId: project.id, data, settings });
      navigate(`/create/publish/${encodeURIComponent(project.id)}`);
    } catch (error) {
      if (signal.aborted) return;
      state.saving = false;
      errorSlot.replaceChildren(failureNotice('Could not save the project', error));
      renderFooter();
    }
  }

  // ── 데이터 ──
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
    state.html = null;
    state.pageMessage = null;
    renderUpload();
    applyContract(); // 이미 있는 계약은 새 데이터로 다시 검사한다
    refreshButtons();
  }

  function renderUpload() {
    const fileInput = el('input', { type: 'file', id: 'task-data-file', accept: '.json,application/json', className: 'dropzone-input' });
    fileInput.addEventListener('change', () => {
      const file = fileInput.files[0];
      fileInput.value = '';
      if (file) void readData(file);
    });
    const dropzone = el(
      'label',
      { className: `dropzone${state.file ? ' dropzone-compact' : ''}`, id: 'task-dropzone', for: 'task-data-file' },
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

  promptInput.value = state.prompt;
  promptInput.addEventListener('input', () => {
    state.prompt = promptInput.value;
    remember();
    refreshButtons();
  });
  pagePrompt.addEventListener('input', () => refreshButtons());
  allowApi.addEventListener('change', () => refreshButtons());
  writeButton.addEventListener('click', () => void writeTask());
  arrangeButton.addEventListener('click', () => void arrangePage());
  plainButton.addEventListener('click', usePlainLayout);
  editor.addEventListener('input', () => {
    clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.contractMessage = null;
      applyContract({ fromEditor: true });
    }, CHECK_DEBOUNCE_MS);
  });

  root.append(
    el('div', { className: 'page-header' }, el('h2', { className: 'page-title' }, 'Create')),
    createSubnav('new'),
    el(
      'section',
      { className: 'panel', id: 'describe-task' },
      el('div', { className: 'panel-head' }, el('h3', { className: 'panel-title' }, 'Describe your task'), el('span', { className: 'panel-actions' }, el('a', { href: '/create/new', className: 'btn btn-small btn-link' }, 'Choose a rough design instead'))),
      muted('No rough design is needed. Upload your HIT data and describe, in your own words, what workers see, where it goes, and which questions they answer: any number and kind of questions. Say which column holds the answers if you want Review to compare with it.'),
      uploadSlot,
      errorSlot,
      el(
        'div',
        { className: 'binding-agent', id: 'task-agent' },
        el('label', { for: 'task-prompt' }, 'Your task'),
        promptInput,
        el('div', { className: 'binding-agent-actions' }, el('label', { className: 'check-label' }, allowApi, ' Allow API calls (uses credits)'), writeButton),
        agentStatus,
        agentError,
      ),
    ),
    contractSlot,
    pageSlot,
    el('section', { className: 'panel', id: 'task-finish' }, field({ id: 'task-project-name', label: 'Project name', control: nameInput, hint: 'Saved as a project when you use this task. You can change its properties and layout later.', required: true }), footerSlot),
  );
  renderUpload();
  loadAgentInfo();
  if (state.file) applyContract();
  else renderContract();
  refreshButtons();
  return () => {
    clearTimeout(state.timer);
    if (typeof state.stopPreview === 'function') state.stopPreview();
  };
}

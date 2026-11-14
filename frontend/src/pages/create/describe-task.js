// New Project 의 "Draft with AI" (/create/new/describe). framework 의 Pipeline Design 단계다: 데이터와 한 줄 목표를 주면 Design Agent 가
// annotation 단위(sentence / chunk / document, image, full video / frame), 보일 값과 문항, 페이지의 배치 바람을 먼저 정하고,
// Requester 는 그 초안을 보며 **대화 한 곳에서** 과제와 페이지를 함께 고친다.
//   1. 데이터: 어느 정도 정리된 JSON 이면 모양에 상관없이 기록 목록을 찾는다 (lib/json-records.js)
//   2. Draft the task: 데이터 요약과 단위 후보(lib/task-unit.js 의 unitOptions)를 보내 계약을 받는다. 코드가 단위대로 기록을 HIT 로
//      바꾸고(planData) 계약을 검사해 틀리면 다시 묻는다 (checkDesign, requestContract)
//   3. 계약에 배치 바람(layout)이 있으면 페이지 Agent 가 기본 페이지를 다시 쓰고 lib/html-harness.js 가 검사한다. 통과한 페이지는 그려서 재고
//      (components/layout-probe.js) 판정 Agent 가 바람마다 대조한다(lib/layout-check.js). 맞지 않으면 다시 묻고, 남으면 경고로 보인다
//   4. 그 뒤의 요청(내용, 단위, 페이지)은 모두 같은 칸으로 보낸다. Design Agent 가 무엇을 바꿀지 정하고, 계약이 바뀌면 페이지도 다시 쓴다.
//      폼(contract-form.js)이나 JSON 으로도 고친다. 대화의 Restore 는 계약과 그때의 페이지를 함께 되돌린다 (lib/contract-revision.js)
//   5. Use this task: Project 를 저장하고, 단위대로 만든 HIT 와 대조 기준·attention 설정을 Publish Batch 로 넘긴다
// Agent 호출은 모두 유료이며 Allow API calls 를 켜야 한다. 올린 데이터는 탭의 메모리에만 두고, Agent 에는 구조와 잘린 표본만 간다.

import { agent } from '../../api-client/client.js';
import { el } from '../../components/dom.js';
import { measurePage } from '../../components/layout-probe.js';
import { muted, notice } from '../../components/notice.js';
import { previewFrame } from '../../components/preview-frame.js';
import { addContractAnswer, earlierRequests, isCurrentContract, sameContract, setVersionPage, versionPage } from '../../lib/contract-revision.js';
import { dataReader, summarizeData } from '../../lib/design-binding.js';
import { draftStorage, emptyDraft } from '../../lib/draft.js';
import { checkAgentHtml, pageRequest, requestHtml } from '../../lib/html-harness.js';
import { readRecordsFile } from '../../lib/json-records.js';
import { fixedFromOutline, layoutNotes, layoutRequest, layoutSummary } from '../../lib/layout-check.js';
import { sampleFor } from '../../lib/project-draft.js';
import { taskContent, taskTypeById } from '../../lib/rough-designs.js';
import { settingsFromProperties } from '../../lib/settings.js';
import { contractOutline, contractSettings, contractTaskType, harnessContract, layoutText, requestContract } from '../../lib/task-contract.js';
import { checkDesign, unitChoices, unitOptions, unitRequest, unitSummary } from '../../lib/task-unit.js';
import { navigate } from '../../router.js';
import { createSubnav, failureNotice, field, stepFooter } from './common.js';
import { contractForm } from './contract-form.js';
import { saveProject } from './rough-design.js';

const PREVIEW_HEIGHT = 880;
const CHECK_DEBOUNCE_MS = 400;
const SAMPLE_ROW_LIMIT = 60 * 1024;
const CHANGE_TEXT_LIMIT = 120;
const HIT_CHOICES = 200;
const GOAL_PLACEHOLDER = 'For example: Is each claim supported by the passage? The answers are in gold. Leave it empty and the model guesses from your data.';
const REVISE_PLACEHOLDER = 'Ask for any change: "make it sentence level", "add a 1 to 5 confidence question", "put the passage on the left and the questions on the right".';
const NO_GOAL = '(No goal given: draft from the data.)';
const RESULT_MARK = { met: '✓', not_met: '✗', unclear: '?' };
const LEVEL_LABEL = { document: 'Document', chunk: 'Chunk', sentence: 'Sentence', image: 'Image', video: 'Full video', frame: 'Frame' };

// 같은 탭에서 다른 화면에 다녀와도 남는 것
let session = null;

const typeLabel = { choice: 'Pick one', likert: 'Score', checklist: 'Check all that apply', 'item-choice': 'One answer per item', text: 'Written answer' };

function problemList(id, level, title, messages) {
  return messages.length === 0 ? null : notice(level, title, null, el('ul', { className: 'warning-list', id }, messages.map((message) => el('li', {}, message))));
}

/** 계약 요약 표: Agent 가 정한 값과 문항, 페이지 바람을 Requester 가 읽고 확인한다. */
function outlineNode(contract) {
  const outline = contractOutline(contract);
  const tag = (text, className = '') => el('span', { className: `tag ${className}`.trim() }, text);
  return el(
    'div',
    { className: 'task-outline', id: 'task-outline' },
    outline.itemLabel ? el('p', { className: 'muted small' }, `Each HIT repeats for every unit: ${outline.itemLabel}.`) : null,
    el('h4', { className: 'section-title' }, 'What workers see'),
    el(
      'table',
      { className: 'table task-outline-table', id: 'task-values' },
      el('thead', {}, el('tr', {}, el('th', {}, 'Value'), el('th', {}, 'From your data'), el('th', {}, 'Shown'))),
      el('tbody', {}, outline.values.map((value) => el('tr', {}, el('td', {}, value.label, value.kind === 'text' ? null : [' ', tag(value.kind)]), el('td', {}, el('code', {}, value.from)), el('td', {}, value.perItem ? 'for each unit' : 'once')))),
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
            el('td', {}, el('strong', {}, question.header), el('div', { className: 'muted small' }, `${typeLabel[question.type] ?? question.type}${question.perItem ? ', for each unit' : ''} · answer name ${question.name}`)),
            el('td', {}, question.answers),
            el('td', {}, question.compared ? tag('Compared with your labels', 'tag-ok') : null, question.attention ? [' ', tag('Attention check')] : null),
          ),
        ),
      ),
    ),
    el('h4', { className: 'section-title' }, 'How the page looks'),
    outline.layout.length > 0 ? el('ul', { className: 'task-wishes', id: 'task-wishes' }, outline.layout.map((wish) => el('li', {}, wish))) : muted('The plain layout: values first, then the questions.'),
  );
}

/** 요청한 배치대로인지의 판정 목록. */
function layoutChecksNode(checks, { remaining = false, id = null } = {}) {
  if (!checks || checks.length === 0) return null;
  const counts = layoutSummary(checks);
  return el(
    'div',
    { className: 'layout-checks', ...(id ? { id } : {}) },
    el('p', { className: 'small' }, el('strong', {}, 'Checked against the page wishes: '), `${counts.met} met, ${counts.not_met} not met, ${counts.unclear} unclear. The page was drawn and measured; the result can be wrong, so look at the preview too.`),
    el(
      'ul',
      { className: 'layout-check-list' },
      checks.map((check) => el('li', { className: `layout-check layout-check-${check.result}`, dataset: { result: check.result } }, el('span', { className: 'layout-check-mark', 'aria-label': check.result }, RESULT_MARK[check.result] ?? '?'), el('span', {}, el('strong', {}, check.wish), check.evidence ? el('span', { className: 'muted' }, ` — ${check.evidence}`) : null))),
    ),
    remaining ? el('p', { className: 'binding-guide' }, 'Some wishes are still not met after the model tried to fix them. Ask again in other words, or keep this page.') : null,
  );
}

export function renderDescribeTask(root, signal) {
  const state = {
    file: session?.file ?? null, // 올린 원본 표 (기록 목록)
    source: null, // 원본 표의 reader
    options: null, // 단위 후보
    goal: session?.goal ?? '',
    contract: session?.contract ?? null,
    contractText: session?.contract ? JSON.stringify(session.contract, null, 2) : '',
    versions: session?.versions ?? [], // lib/contract-revision.js 의 대화 기록
    check: null, // checkDesign 결과 (단위대로 만든 HIT 표 포함)
    harness: null,
    page: session?.page ?? null, // 다시 쓴 페이지 { html, message, checks, remaining, errors, stale }. null 이면 기본 페이지
    sending: false,
    arranging: false,
    hit: 0,
    saving: false,
    nameEdited: false,
    timer: null,
    stopPreview: null,
  };
  let agentInfo = null;

  const uploadSlot = el('div', { id: 'task-data-upload' });
  const dataInfo = el('div', { id: 'task-data-info' });
  const errorSlot = el('div', { id: 'task-data-error' });
  const contractSlot = el('div', { id: 'task-contract' });
  const pageSlot = el('div', { id: 'task-page' });
  const footerSlot = el('div', {});

  const threadSlot = el('div', { className: 'binding-thread', id: 'task-thread' });
  const goalLabel = el('label', { for: 'task-goal', id: 'task-goal-label' }, 'What should workers label? (one line, optional)');
  const goalInput = el('textarea', { id: 'task-goal', rows: 2, placeholder: GOAL_PLACEHOLDER });
  const promptLabel = el('label', { for: 'task-prompt', id: 'task-prompt-label' }, 'Ask for a change');
  const promptInput = el('textarea', { id: 'task-prompt', rows: 3, placeholder: REVISE_PLACEHOLDER });
  const allowApi = el('input', { type: 'checkbox', id: 'task-allow-api' });
  const sendButton = el('button', { type: 'button', className: 'btn btn-primary btn-small', id: 'write-task' });
  const restartButton = el('button', { type: 'button', className: 'btn btn-small btn-link', id: 'restart-task' }, 'Start over');
  const agentStatus = el('div', { className: 'muted small', id: 'task-agent-status' });
  const agentError = el('div', { id: 'task-agent-error' });
  const editor = el('textarea', { id: 'contract-editor', className: 'binding-editor', rows: 16, spellcheck: 'false', 'aria-label': 'Task contract' });
  const formSlot = el('fieldset', { className: 'binding-form-wrap', id: 'contract-form-wrap' });
  const nameInput = el('input', { type: 'text', id: 'task-project-name', maxlength: '200' });
  nameInput.addEventListener('input', () => {
    state.nameEdited = true;
    renderFooter();
  });

  function remember() {
    session = { file: state.file, goal: state.goal, contract: state.contract, versions: state.versions, page: state.page };
  }

  const usable = () => Boolean(state.file && state.harness);
  const currentHtml = () => state.page?.html ?? state.harness?.html ?? '';
  const busy = () => state.sending || state.arranging;
  const allowed = () => Boolean(agentInfo?.api_allowed && allowApi.checked);

  function refreshButtons() {
    const drafted = Boolean(state.contract);
    goalLabel.hidden = drafted;
    goalInput.hidden = drafted;
    promptLabel.hidden = !drafted;
    promptInput.hidden = !drafted;
    sendButton.disabled = busy() || !state.file || !allowed() || (drafted && promptInput.value.trim() === '');
    sendButton.textContent = state.sending ? (drafted ? 'Sending…' : 'Drafting…') : state.arranging ? 'Arranging…' : drafted ? 'Send' : 'Draft the task';
    restartButton.hidden = !drafted;
    restartButton.disabled = busy();
    for (const button of root.querySelectorAll('[data-unit], #arrange-again')) button.disabled = busy() || !allowed();
    editor.readOnly = busy();
    formSlot.disabled = busy();
  }

  function renderFooter() {
    const name = nameInput.value.trim();
    footerSlot.replaceChildren(
      stepFooter({
        onBack: () => navigate('/create/new'),
        onNext: () => void useTask(),
        nextLabel: state.saving ? 'Saving…' : 'Use this task',
        nextId: 'use-task',
        nextDisabled: state.saving || busy() || !usable() || name === '',
        hint: !state.file ? 'Upload your data to continue.' : !state.contract ? 'Let the model draft the task, or paste a task contract below.' : !usable() ? 'Fix the task to continue.' : name === '' ? 'Enter a project name to continue.' : 'Next, review the HIT data and publish the batch.',
      }),
    );
  }

  // ── 대화 ──
  const clip = (text) => (text.length > CHANGE_TEXT_LIMIT ? `${text.slice(0, CHANGE_TEXT_LIMIT)}…` : text);
  function changeLine({ what, before, after, alert }) {
    const detail = before === '' ? ['added: ', el('span', { className: 'binding-change-new' }, clip(after))] : after === '' ? ['removed: ', el('span', { className: 'binding-change-old' }, clip(before))] : [el('span', { className: 'binding-change-old' }, clip(before)), ' → ', el('span', { className: 'binding-change-new' }, clip(after))];
    return el('li', { className: alert ? 'binding-change-alert' : null }, el('strong', {}, `${what} `), detail);
  }

  /** 답 아래의 페이지 결과. undefined 면 이 답은 페이지를 건드리지 않았다. */
  function pagePart(version, arranging) {
    if (arranging) return el('p', { className: 'muted small task-page-pending' }, 'Arranging the page, then drawing and checking it…');
    if (!('page' in version)) return null;
    const page = version.page;
    if (page === null) return el('p', { className: 'muted small' }, 'Page: the plain layout.');
    if (!page.html) return el('div', { className: 'binding-guide' }, el('p', {}, 'The page could not be arranged, so the plain layout is shown:'), el('ul', { className: 'warning-list' }, (page.errors ?? []).map((text) => el('li', {}, text))));
    return [page.message ? el('p', {}, el('strong', {}, 'Page: '), page.message) : null, layoutChecksNode(page.checks, { remaining: page.remaining })];
  }

  function versionNode(version, index) {
    const current = isCurrentContract(version, state.contract);
    const restore = version.text === undefined ? null : current ? el('span', { className: 'tag binding-current' }, 'Current') : el('button', { type: 'button', className: 'btn btn-small btn-link binding-restore', disabled: busy(), onClick: () => restoreVersion(version) }, 'Restore');
    if (version.kind === 'edit') return el('div', { className: 'binding-turn binding-turn-note', dataset: { kind: 'edit' } }, el('span', { className: 'muted small' }, 'Your edits before the next request'), restore);
    const alerts = (version.changes ?? []).some((change) => change.alert);
    const last = index === state.versions.length - 1;
    return el(
      'div',
      { className: 'binding-turn', dataset: { kind: version.kind } },
      el('div', { className: 'binding-bubble binding-bubble-you' }, version.request),
      el(
        'div',
        { className: 'binding-bubble binding-bubble-model' },
        version.message ? el('p', {}, version.message) : null,
        version.kind === 'reply' && !version.message ? el('p', {}, 'The model changed nothing.') : null,
        version.changes?.length > 0 ? el('ul', { className: 'binding-changes' }, version.changes.map(changeLine)) : null,
        alerts ? el('p', { className: 'binding-guide' }, 'Something marked above was removed. Answers to a removed or renamed question no longer connect to Review. If you did not ask for that, restore the previous version.') : null,
        version.problems?.length > 0 ? el('p', { className: 'binding-guide' }, 'The model could not fix every problem. Fix the problems listed below, or ask again.') : null,
        pagePart(version, last && state.arranging),
        el('div', { className: 'binding-turn-foot' }, el('span', { className: 'muted small' }, [version.meta, version.page?.meta].filter(Boolean).join(' · ')), restore),
      ),
    );
  }

  function renderThread() {
    threadSlot.replaceChildren(...state.versions.map(versionNode));
    threadSlot.hidden = state.versions.length === 0;
    threadSlot.scrollTop = threadSlot.scrollHeight;
  }

  function restoreVersion(version) {
    if (busy()) return;
    state.contract = JSON.parse(version.text);
    state.page = versionPage(version);
    applyContract();
  }

  // ── 계약 ──
  /** 계약을 단위대로 바꾼 HIT 표로 검사한다. manual: 폼·JSON 으로 고친 것 (다시 쓴 페이지가 맞지 않으면 다시 배치하라고 알린다). */
  function applyContract({ fromEditor = false, keepForm = false, manual = false } = {}) {
    if (fromEditor) {
      try {
        state.contract = JSON.parse(editor.value);
      } catch (error) {
        state.check = { errors: [`The task contract is not valid JSON: ${error.message}`], warnings: [], tabs: 0, data: null, reader: null };
        state.harness = null;
        renderContract({ keepForm: true });
        return;
      }
    }
    state.contractText = JSON.stringify(state.contract, null, 2);
    state.check = state.contract && state.file ? checkDesign(state.contract, state.file) : null;
    state.harness = state.check && state.check.errors.length === 0 ? harnessContract(state.contract, state.check.reader) : null;
    // 페이지 바람을 모두 지우면 기본 페이지다
    if (state.page && state.contract && layoutText(state.contract) === '') state.page = null;
    if (state.page?.html && state.harness) {
      if (checkAgentHtml(state.page.html, state.harness).errors.length > 0) state.page = { html: null, errors: ['The task changed, so the arranged page no longer fits it.'], stale: true };
      else if (manual) state.page = { ...state.page, stale: true };
    } else if (manual && state.page && layoutText(state.contract) !== '') state.page = { ...state.page, stale: true };
    remember();
    renderContract({ keepForm });
  }

  function renderForm() {
    const focused = formSlot.contains(document.activeElement) ? document.activeElement.id : null;
    if (!state.contract || typeof state.contract !== 'object' || !state.check?.reader) {
      formSlot.replaceChildren(muted('The form cannot read this task. Fix it in the JSON editor.'));
      return;
    }
    formSlot.replaceChildren(contractForm({ get: () => state.contract, reader: state.check.reader, onChange: changeFromForm }));
    if (focused) document.getElementById(focused)?.focus();
  }

  function changeFromForm(next, structural) {
    state.contract = next;
    editor.value = JSON.stringify(next, null, 2);
    clearTimeout(state.timer);
    if (structural) applyContract({ manual: true });
    else state.timer = setTimeout(() => applyContract({ keepForm: true, manual: true }), CHECK_DEBOUNCE_MS);
  }

  function unitNode() {
    const summary = unitSummary(state.contract, state.file, state.check?.data);
    const choices = state.options ? unitChoices(state.options, state.contract) : [];
    return el(
      'div',
      { className: 'task-unit', id: 'task-unit' },
      el(
        'div',
        { className: 'task-unit-head' },
        el('span', { className: 'muted small' }, 'Unit'),
        el('strong', { id: 'task-unit-level' }, LEVEL_LABEL[summary.level] ?? 'Not decided'),
        state.check?.data ? el('span', { className: 'muted small', id: 'task-unit-count' }, `${summary.records.toLocaleString('en-US')} record(s) → ${summary.hits.toLocaleString('en-US')} HIT(s)`) : null,
      ),
      summary.why ? el('p', { className: 'task-unit-why', id: 'task-unit-why' }, summary.why) : null,
      summary.how.length > 0 ? el('p', { className: 'muted small' }, `${summary.how.join('; ')}.`) : null,
      choices.length > 0
        ? el(
            'div',
            { className: 'task-unit-choices' },
            el('span', { className: 'muted small' }, 'Ask for another unit:'),
            choices.map((level) => el('button', { type: 'button', className: 'btn btn-small', dataset: { unit: level }, disabled: busy() || !allowed(), onClick: () => void send(unitRequest(LEVEL_LABEL[level].toLowerCase())) }, LEVEL_LABEL[level])),
          )
        : null,
    );
  }

  function renderContract({ keepForm = false } = {}) {
    renderThread();
    if (!state.file) {
      contractSlot.replaceChildren();
      pageSlot.replaceChildren();
      refreshButtons();
      renderFooter();
      return;
    }
    if (!state.contract && !state.check) {
      contractSlot.replaceChildren(el('details', { className: 'binding-json', id: 'contract-json' }, el('summary', {}, 'Paste a task contract instead (advanced)'), muted('The same JSON the model writes. See agent/contract_reference.md for the format.'), editor));
      pageSlot.replaceChildren();
      refreshButtons();
      renderFooter();
      return;
    }
    const { errors = [], warnings = [] } = state.check ?? {};
    if (document.activeElement !== editor) editor.value = state.contractText;
    if (!keepForm) renderForm();
    contractSlot.replaceChildren(
      el(
        'section',
        { className: 'panel', id: 'task-contract-panel' },
        el('div', { className: 'panel-head' }, el('h3', { className: 'panel-title' }, 'The task')),
        muted('The model decided all of this. Ask for changes in the chat above, or change it here. The page below follows the task.'),
        state.contract && typeof state.contract === 'object' ? unitNode() : null,
        problemList('task-errors', 'error', 'The task cannot be used yet', errors),
        problemList('task-warnings', 'warning', 'Check these before you publish', warnings),
        state.contract && errors.length === 0 ? outlineNode(state.contract) : null,
        el('details', { className: 'binding-json contract-form-details', id: 'contract-form-details' }, el('summary', {}, 'Edit the task'), formSlot),
        el('details', { className: 'binding-json', id: 'contract-json' }, el('summary', {}, 'Edit as JSON (advanced)'), editor),
      ),
    );
    renderPage();
    if (!state.nameEdited && state.contract?.instructions) nameInput.value = state.file ? `${state.file.fileName.replace(/\.jsonl?$/i, '')} task` : 'New task';
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
    const hitSelect = el('select', { id: 'task-hit', 'aria-label': 'HIT' }, Array.from({ length: Math.min(rows.length, HIT_CHOICES) }, (_, index) => el('option', { value: String(index) }, `HIT ${index + 1}${rows[index].unit_part && rows[index].unit_part !== '1' ? ` (part ${rows[index].unit_part})` : ''}`)));
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
    const page = state.page;
    const arranged = Boolean(page?.html);
    const wishes = layoutText(state.contract) !== '';
    const note = page?.stale
      ? el(
          'div',
          { className: 'binding-agent', id: 'page-stale' },
          notice('warning', arranged ? 'You changed the task after the page was arranged. The page may not show your changes yet.' : (page.errors ?? [])[0] ?? 'The arranged page no longer fits the task, so the plain layout is shown.'),
          wishes ? el('div', { className: 'binding-agent-actions' }, el('button', { type: 'button', className: 'btn btn-small', id: 'arrange-again', disabled: busy() || !allowed(), onClick: () => void arrangeAgain() }, 'Arrange the page again')) : null,
        )
      : null;
    pageSlot.replaceChildren(
      el(
        'section',
        { className: 'panel', id: 'task-page-panel' },
        el('div', { className: 'panel-head' }, el('h3', { className: 'panel-title' }, arranged ? 'The page, arranged by the model' : 'The page (plain layout)'), el('span', { className: 'panel-actions' }, hitSelect, el('span', { className: 'muted small' }, `of ${rows.length.toLocaleString('en-US')} HITs`))),
        muted(arranged ? 'Arranged from the page wishes of the task. Every value and question is kept and answers are never shown: the console checked it.' : 'Values first, then the questions. Ask in the chat for another arrangement.'),
        note,
        arranged ? layoutChecksNode(page.checks, { remaining: page.remaining, id: 'layout-checks' }) : null,
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

  const costOf = (usage) => (typeof usage?.cost === 'number' ? `, $${usage.cost.toFixed(4)}` : '');
  const metaOf = (result, model) => `${model?.model ?? 'the model'} (${model?.served_by ?? 'any provider'}): ${result.attempts} attempt(s)${costOf(result.usage)}`;

  /** 계약 요청(내용, 단위, 페이지 무엇이든)을 보내고, 바뀐 계약대로 페이지를 다시 쓴다. text 가 있으면 그 글을 보낸다 (단위 버튼). */
  async function send(text = null) {
    if (busy() || !state.source) return;
    const before = state.contract;
    const beforePage = state.page;
    const request = before ? (text ?? promptInput.value).trim() : '';
    if (before && request === '') return;
    if (!before) state.goal = goalInput.value.trim();
    state.sending = true;
    agentError.replaceChildren();
    agentStatus.textContent = before ? 'Asking the model.' : 'Asking the model to draft the task: the unit, the values, the questions and the page. This can take a minute.';
    renderThread();
    refreshButtons();
    renderFooter();
    let model = null;
    try {
      const result = await requestContract({
        send: async (body) => {
          const reply = await agent.createContract(body);
          model = reply.model;
          return reply;
        },
        check: (contract) => checkDesign(contract, state.file, { requireUnit: true }),
        request: {
          goal: state.goal,
          data: summarizeData(state.source),
          units: state.options,
          allow_api: true,
          ...(before ? { request, current: before, earlier_requests: earlierRequests(state.versions) } : {}),
        },
      });
      if (signal.aborted) return;
      const meta = metaOf(result, model);
      agentStatus.textContent = `Last answer from ${meta}.`;
      state.versions = addContractAnswer(state.versions, { before, beforePage, result, request: before ? request : state.goal || NO_GOAL, meta });
      if (before) promptInput.value = '';
      if (result.contract) {
        state.contract = result.contract;
        if (!before) state.page = null; // 새 과제이므로 페이지도 처음부터다
        applyContract();
      }
      state.sending = false;
      if (result.contract && state.harness && needsArrange(before, beforePage)) await arrange();
      else if (state.harness && result.contract && layoutText(state.contract) === '' && (!before || state.page)) {
        state.page = null;
        state.versions = setVersionPage(state.versions, null);
      }
    } catch (error) {
      if (!signal.aborted) {
        agentStatus.textContent = '';
        agentError.replaceChildren(failureNotice(before ? 'Could not send the request' : 'Could not draft the task', error));
      }
    } finally {
      state.sending = false;
      remember();
      renderContract({ keepForm: false });
    }
  }

  /** 계약이 바뀌었거나, 바람이 있는데 다시 쓴 페이지가 없거나 지난 것이면 페이지를 다시 쓴다. */
  function needsArrange(before, beforePage) {
    if (layoutText(state.contract) === '') return false;
    return !sameContract(before, state.contract) || !beforePage?.html || Boolean(beforePage?.stale);
  }

  /** 페이지를 그려 재고 판정 Agent 에게 묻는다 → { notes, checks, usage }. */
  async function reviewLayout(html, wish) {
    const page = await measurePage(html, state.harness.data.rows[state.hit] ?? state.harness.data.rows[0]);
    const reply = await agent.createLayoutCheck({ ...layoutRequest(wish, page, fixedFromOutline(contractOutline(state.contract))), allow_api: true });
    return { notes: layoutNotes(reply.checks), checks: reply.checks ?? [], usage: reply.usage, model: reply.model };
  }

  /** 계약의 배치 바람대로 페이지를 다시 쓰고 검사·판정한다. 결과는 state.page 와 대화의 마지막 줄에 남는다. */
  async function arrange() {
    const harness = state.harness;
    const wish = layoutText(state.contract);
    state.arranging = true;
    renderThread();
    refreshButtons();
    renderFooter();
    agentStatus.textContent = 'Arranging the page, then drawing and checking it against the page wishes.';
    let model = null;
    try {
      const result = await requestHtml({
        send: async (body) => {
          const reply = await agent.createPage(body);
          model = reply.model;
          return reply;
        },
        check: (html) => checkAgentHtml(html, harness),
        review: (html) => reviewLayout(html, wish),
        request: { ...pageRequest(harness, wish, contractTaskType(state.contract)), allow_api: true },
      });
      if (signal.aborted) return;
      const meta = `page ${metaOf(result, model)} (with the checks)`;
      agentStatus.textContent = `Last answer from ${meta}.`;
      // 검사를 통과한 페이지가 하나도 없으면 쓰지 않는다
      state.page = result.cannot || result.errors.length > 0 ? { html: null, message: result.message ?? null, errors: [result.message, ...result.errors].filter(Boolean), meta } : { html: result.html, message: result.message ?? null, checks: result.checks, remaining: result.notes.length > 0, meta };
    } catch (error) {
      if (signal.aborted) return;
      state.page = { html: null, errors: [`Could not arrange the page: ${error.message ?? error}`] };
    } finally {
      state.arranging = false;
    }
    state.versions = setVersionPage(state.versions, state.page);
    remember();
  }

  async function arrangeAgain() {
    if (busy() || !state.harness) return;
    await arrange();
    if (!signal.aborted) renderContract({ keepForm: false });
  }

  function startOver() {
    if (busy()) return;
    state.contract = null;
    state.check = null;
    state.harness = null;
    state.versions = [];
    state.page = null;
    goalInput.value = state.goal;
    editor.value = '';
    remember();
    renderContract();
  }

  async function useTask() {
    if (state.saving || busy() || !usable()) return;
    const name = nameInput.value.trim();
    if (name === '') return;
    state.saving = true;
    errorSlot.replaceChildren();
    renderFooter();
    const html = currentHtml();
    const data = { ...state.harness.data, fileName: state.file.fileName.replace(/\.jsonl$/i, '.json') };
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
  function useFile(parsed) {
    state.file = parsed;
    state.source = dataReader(parsed);
    state.options = unitOptions(state.source);
  }

  async function readData(file) {
    errorSlot.replaceChildren();
    let parsed;
    try {
      parsed = await readRecordsFile(file);
    } catch (error) {
      if (!signal.aborted) errorSlot.replaceChildren(failureNotice(`Could not read ${file.name}`, error));
      return;
    }
    if (signal.aborted) return;
    useFile(parsed);
    state.hit = 0;
    state.page = null;
    renderUpload();
    applyContract(); // 이미 있는 계약은 새 데이터로 다시 검사한다
    refreshButtons();
  }

  function renderUpload() {
    const fileInput = el('input', { type: 'file', id: 'task-data-file', accept: '.json,.jsonl,application/json', className: 'dropzone-input' });
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
        ? el('span', { className: 'dropzone-text' }, `${state.file.fileName}: ${state.file.rows.length.toLocaleString('en-US')} record(s), ${state.file.columns.length} column(s). Drop another file here, or click to replace it.`)
        : [el('span', { className: 'dropzone-text' }, 'Drop your data here, or click to choose a JSON file'), el('span', { className: 'muted small' }, 'A list of records, an object that holds one, records keyed by id, or JSON Lines. Nested values are fine. It stays in this browser tab.')],
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
    dataInfo.replaceChildren(
      ...(state.file
        ? [
            el('p', { className: 'muted small', id: 'task-data-columns' }, `Columns: ${state.file.columns.join(', ')}`),
            state.file.warnings.length > 0 ? el('ul', { className: 'muted small task-data-notes', id: 'task-data-notes' }, state.file.warnings.map((text) => el('li', {}, text))) : null,
          ].filter(Boolean)
        : []),
    );
  }

  goalInput.value = state.goal;
  goalInput.addEventListener('input', () => {
    state.goal = goalInput.value;
    remember();
  });
  promptInput.addEventListener('input', () => refreshButtons());
  promptInput.addEventListener('keydown', (event) => {
    // Ctrl/Cmd+Enter 로 보낸다
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !sendButton.disabled) void send();
  });
  allowApi.addEventListener('change', () => refreshButtons());
  sendButton.addEventListener('click', () => void send());
  restartButton.addEventListener('click', startOver);
  editor.addEventListener('input', () => {
    clearTimeout(state.timer);
    state.timer = setTimeout(() => applyContract({ fromEditor: true, manual: true }), CHECK_DEBOUNCE_MS);
  });

  root.append(
    el('div', { className: 'page-header' }, el('h2', { className: 'page-title' }, 'Create')),
    createSubnav('new'),
    el(
      'section',
      { className: 'panel', id: 'describe-task' },
      el('div', { className: 'panel-head' }, el('h3', { className: 'panel-title' }, 'Draft with AI'), el('span', { className: 'panel-actions' }, el('a', { href: '/create/new', className: 'btn btn-small btn-link' }, 'Choose a rough design instead'))),
      muted('Upload your data and say in one line what workers should label. The model decides the unit (a sentence, a chunk or the whole document; the whole video or a frame), the questions and the page. Then ask for any change in the same chat: the task and the page change together.'),
      uploadSlot,
      dataInfo,
      errorSlot,
      el(
        'div',
        { className: 'binding-agent', id: 'task-agent' },
        threadSlot,
        goalLabel,
        goalInput,
        promptLabel,
        promptInput,
        el('div', { className: 'binding-agent-actions' }, el('label', { className: 'check-label' }, allowApi, ' Allow API calls (uses credits)'), restartButton, sendButton),
        agentStatus,
        agentError,
      ),
    ),
    contractSlot,
    pageSlot,
    el('section', { className: 'panel', id: 'task-finish' }, field({ id: 'task-project-name', label: 'Project name', control: nameInput, hint: 'Saved as a project when you use this task. You can change its properties and layout later.', required: true }), footerSlot),
  );
  if (state.file) useFile(state.file);
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

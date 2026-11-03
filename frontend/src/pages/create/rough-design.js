// New Project 의 첫 흐름: rough design 고르기 → task 종류 고르기와 예시 미리보기 → 기존 Publish Batch 의 Upload JSON.
//   /create/new                               가안 고르기. 도형 배치만 보이고, 아래에 다른 시작 방법으로 가는 링크가 있다
//   /create/new/design/:designId(/:taskType)  Vision / Video / Text 고르기. 고른 가안에 예시 자료를 넣어 worker 화면으로 보인다
// 고른 값은 주소에 있으므로 새로고침해도 남는다. `Use this design` 이 Project 를 저장하고 그 Publish Batch 로 간다.
// 가안의 정의와 템플릿 조립은 lib/rough-designs.js 에 있다.

import { api } from '../../api-client/client.js';
import { el } from '../../components/dom.js';
import { muted, notice } from '../../components/notice.js';
import { previewFrame } from '../../components/preview-frame.js';
import { toSaveRequest } from '../../lib/project-draft.js';
import { ROUGH_DESIGNS, SLOT_LABELS, TASK_TYPES, buildDesignTemplate, designPath, findSameProject, roughDesignById, taskTypeById } from '../../lib/rough-designs.js';
import { STARTERS } from '../../lib/starters.js';
import { extractPlaceholders } from '../../lib/template.js';
import { navigate } from '../../router.js';
import { createSubnav, failureNotice, field, placeholderTags, stepFooter } from './common.js';
import { pendingProjectNotice, presetChoice } from './new-project.js';

const STEP_TITLES = ['Rough design', 'Task type and preview', 'HIT data'];
const DESIGN_KEY = 'mturk-console:rough-design';
const PREVIEW_HEIGHT = 880;

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

function stepsBar(active, designId) {
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
              else if (index === 1) navigate(designPath(designId));
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
  let nameEdited = false;
  let saving = false;

  const previewSlot = el('div', { id: 'design-preview' });
  const errorSlot = el('div', { id: 'design-error' });
  const nameInput = el('input', { type: 'text', id: 'design-project-name', maxlength: '200' });
  nameInput.addEventListener('input', () => {
    nameEdited = true;
    renderFooter();
  });
  const nameField = field({ id: 'design-project-name', label: 'Project name', control: nameInput, hint: 'Saved as a project. You can change its properties and layout later.', required: true });
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
        onNext: () => void useDesign(),
        nextLabel: saving ? 'Saving…' : 'Use this design',
        nextId: 'use-design',
        nextDisabled: saving || !taskType || nameInput.value.trim() === '',
        hint: !taskType ? 'Choose a task type to continue.' : nameInput.value.trim() === '' ? 'Enter a project name to continue.' : 'Next, upload the data for the HITs.',
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
    nameField.hidden = !taskType;
    if (!taskType) {
      previewSlot.replaceChildren();
      renderFooter();
      return;
    }
    const built = buildDesignTemplate(design, taskType);
    if (!nameEdited) nameInput.value = built.name;
    const frame = previewFrame({ html: built.html, row: built.sampleRow, height: PREVIEW_HEIGHT });
    stopPreview = frame.destroy;
    previewSlot.replaceChildren(
      el('h4', { className: 'section-title' }, `Preview: ${design.title} with ${taskType.title} samples`),
      muted('This is what workers see, filled with sample data. The questions are examples too; change them later in Design Layout.'),
      el('div', { className: 'gallery-meta' }, el('span', { className: 'muted' }, 'Data columns you will upload next: '), placeholderTags(extractPlaceholders(built.html))),
      frame.node,
    );
    renderFooter();
  }

  function selectType(type) {
    if (taskType?.id === type.id) return;
    taskType = type;
    errorSlot.replaceChildren();
    // 미리보기만 바꾼다. 주소에 남겨 두어 새로고침해도 고른 종류가 유지되게 한다
    history.replaceState(null, '', designPath(design.id, type.id));
    renderType();
  }

  async function useDesign() {
    if (saving || !taskType) return;
    const name = nameInput.value.trim();
    if (name === '') return;
    saving = true;
    errorSlot.replaceChildren();
    renderFooter();
    const built = buildDesignTemplate(design, taskType);
    try {
      const templates = await api.listTemplates();
      const project =
        findSameProject(templates, name, built.html) ??
        (await api.saveTemplate(toSaveRequest({ projectId: null, name, html: built.html, settings: built.properties, sampleRow: built.sampleRow })));
      if (!signal.aborted) navigate(`/create/publish/${encodeURIComponent(project.id)}`);
    } catch (error) {
      if (signal.aborted) return;
      saving = false;
      errorSlot.replaceChildren(failureNotice('Could not save the project', error));
      renderFooter();
    }
  }

  root.append(
    el('div', { className: 'page-header' }, el('h2', { className: 'page-title' }, 'Create')),
    createSubnav('new'),
    stepsBar(1, design.id),
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
      errorSlot,
      nameField,
      footerSlot,
    ),
  );
  renderType();
  return () => {
    if (typeof stopPreview === 'function') stopPreview();
  };
}

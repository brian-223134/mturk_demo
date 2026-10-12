// Create → New Project: 무엇으로 시작할지 고른다 (MTurk 의 "Select a customizable template to start a new project").
// 왼쪽은 starter 템플릿(lib/starters.js)과 다른 시작 방법 두 가지(HTML 올리기, 원본 데이터에서 agent 로 만들기), 오른쪽은 고른 것의
// 설명과 실제 미리보기다. starter 의 미리보기는 표본 행으로 그린 worker 화면 그대로이고 Submit 도 가로채 보인다.
// Create Project 를 누르면 새 Project 의 임시 저장(lib/project-draft.js, key 'new')을 만들고 편집기로 간다.

import { agent, api } from '../../api-client/client.js';
import { el } from '../../components/dom.js';
import { confirmModal } from '../../components/modal.js';
import { loading, muted, notice } from '../../components/notice.js';
import { previewFrame } from '../../components/preview-frame.js';
import { decodeUtf8, parseCsv } from '../../lib/csv.js';
import { draftStorage, emptyDraft } from '../../lib/draft.js';
import { NEW_PROJECT, emptyProjectDraft, projectDraftFromStarter, projectDraftStorage, sampleFor } from '../../lib/project-draft.js';
import { applyJobSettings, settingsFromProperties } from '../../lib/settings.js';
import { STARTERS, STARTER_CATEGORIES, starterById, starterUrl } from '../../lib/starters.js';
import { extractPlaceholders } from '../../lib/template.js';
import { navigate } from '../../router.js';
import { createSubnav, failureNotice, placeholderTags } from './common.js';
import { mountGenerate } from './generate.js';

const CHOICE_KEY = 'mturk-console:new-project-choice';
const PREVIEW_HEIGHT = 560;
const SAMPLE_ROW_LIMIT = 60 * 1024; // backend 의 sampleRow 상한(64KB)보다 조금 작게

const OTHER_STARTS = [
  { id: 'upload', title: 'Upload or paste HTML', summary: 'Start from an empty layout and upload or paste your own template HTML.' },
  { id: 'generate', title: 'Generate from raw data', summary: 'Give raw JSON and a prompt. The agent writes the layout and the CSV for you.' },
];

function readChoice() {
  try {
    const value = sessionStorage.getItem(CHOICE_KEY);
    if (value && (starterById(value) || OTHER_STARTS.some((o) => o.id === value))) return value;
  } catch {
    // 저장소를 못 쓰면 첫 starter 를 고른다
  }
  return STARTERS[0].id;
}

function writeChoice(value) {
  try {
    sessionStorage.setItem(CHOICE_KEY, value);
  } catch {
    // 고른 것을 기억하지 못할 뿐이다
  }
}

/** 이어서 고칠 새 Project 가 있으면 그 draft (이름이나 layout 이 있는 것만). */
async function pendingNewProject() {
  const loaded = await projectDraftStorage().load(NEW_PROJECT);
  if (!loaded) return null;
  const { draft } = loaded;
  return draft.name.trim() !== '' || draft.html.trim() !== '' ? draft : null;
}

/** 새 Project 의 draft 를 쓰고 편집기로 간다. 저장하지 않은 새 Project 가 있으면 먼저 묻는다. */
async function startProject(draft, tab, signal) {
  const pending = await pendingNewProject();
  if (signal.aborted) return;
  if (pending) {
    const ok = await confirmModal({
      title: 'Start a new project',
      message: `The new project "${pending.name.trim() || 'Untitled'}" has not been saved. Starting another one discards it.`,
      okText: 'Discard it and start',
      danger: true,
    });
    if (!ok || signal.aborted) return;
  }
  // 저장소는 메모리 사본을 바로 만든다. IndexedDB 에 다 쓰기를 기다리지 않고 편집기로 간다
  void projectDraftStorage().save(NEW_PROJECT, draft);
  if (!signal.aborted) navigate(`/create/project/${NEW_PROJECT}/${tab}`);
}

export async function renderNewProject(root, signal) {
  let choice = readChoice();
  let stopDetail = null;
  const list = el('nav', { className: 'gallery-list', id: 'gallery-list', 'aria-label': 'Templates' });
  const detail = el('div', { className: 'gallery-detail', id: 'gallery-detail' });
  const pendingSlot = el('div', { id: 'pending-project' });

  root.append(
    el('div', { className: 'page-header' }, el('h2', { className: 'page-title' }, 'Create')),
    createSubnav('new'),
    pendingSlot,
    el(
      'section',
      { className: 'panel', id: 'new-project' },
      el('div', { className: 'panel-head' }, el('h3', { className: 'panel-title' }, 'Select a template to start a new project')),
      muted(
        'A new project starts from a template, your own HTML, or a layout generated from raw data. You set its properties and layout here, then publish batches from it in New Batch with an Existing Project. The preview shows sample data; your CSV replaces it when you publish a batch.',
      ),
      el('div', { className: 'gallery' }, list, detail),
    ),
  );

  function renderList() {
    const item = (id, title) =>
      el(
        'button',
        { type: 'button', className: `gallery-item${id === choice ? ' active' : ''}`, dataset: { choice: id }, 'aria-pressed': id === choice ? 'true' : 'false', onClick: () => select(id) },
        title,
      );
    list.replaceChildren(
      ...STARTER_CATEGORIES.flatMap((category) => {
        const starters = STARTERS.filter((s) => s.category === category.key);
        return starters.length === 0 ? [] : [el('div', { className: 'gallery-group' }, category.label), ...starters.map((s) => item(s.id, s.title))];
      }),
      el('div', { className: 'gallery-group' }, 'Other ways to start'),
      ...OTHER_STARTS.map((o) => item(o.id, o.title)),
    );
  }

  function select(id) {
    if (id === choice) return;
    choice = id;
    writeChoice(id);
    renderList();
    void renderDetail();
  }

  async function renderDetail() {
    if (typeof stopDetail === 'function') stopDetail();
    stopDetail = null;
    const starter = starterById(choice);
    if (starter) {
      detail.replaceChildren(loading());
      let html;
      try {
        const response = await fetch(starterUrl(starter), { cache: 'no-cache' });
        if (!response.ok) throw new Error(`${starterUrl(starter)}: HTTP ${response.status}`);
        html = await response.text();
      } catch (error) {
        if (!signal.aborted && choice === starter.id) detail.replaceChildren(failureNotice('Could not load the template', error));
        return;
      }
      if (signal.aborted || choice !== starter.id) return;
      const frame = previewFrame({ html, row: starter.sampleRow, height: PREVIEW_HEIGHT });
      stopDetail = frame.destroy;
      const create = el('button', { type: 'button', className: 'btn btn-primary', id: 'create-project' }, 'Create Project');
      create.addEventListener('click', () => void startProject(projectDraftFromStarter(starter, html), 'properties', signal));
      detail.replaceChildren(
        el('div', { className: 'gallery-head' }, el('div', {}, el('h3', { className: 'gallery-title' }, starter.title), el('p', { className: 'gallery-summary' }, starter.summary)), create),
        el('div', { className: 'gallery-meta' }, el('span', { className: 'muted' }, 'CSV columns: '), placeholderTags(extractPlaceholders(html))),
        frame.node,
      );
      return;
    }
    if (choice === 'upload') {
      const create = el('button', { type: 'button', className: 'btn btn-primary', id: 'create-project' }, 'Create Project');
      create.addEventListener('click', () => void startProject(emptyProjectDraft(), 'layout', signal));
      detail.replaceChildren(
        el('div', { className: 'gallery-head' }, el('div', {}, el('h3', { className: 'gallery-title' }, OTHER_STARTS[0].title), el('p', { className: 'gallery-summary' }, OTHER_STARTS[0].summary)), create),
        el(
          'ul',
          { className: 'gallery-notes' },
          el('li', {}, 'Use ', el('code', {}, '${column}'), ' placeholders for the CSV values, or read ', el('code', {}, 'window.TASK_DATA'), '.'),
          el('li', {}, 'Layouts written with ', el('code', {}, '<ann-*>'), ' elements get answer checks, the Submit button and the answer list for Review for free. Insert them from the Design Layout toolbar.'),
          el('li', {}, 'Older MTurk templates with ', el('code', {}, '<crowd-form>'), ' also work. They load crowd-html-elements from assets.crowd.aws.'),
        ),
      );
      return;
    }
    const holder = el('div', { id: 'generate-mode' });
    detail.replaceChildren(
      el('div', { className: 'gallery-head' }, el('div', {}, el('h3', { className: 'gallery-title' }, OTHER_STARTS[1].title), el('p', { className: 'gallery-summary' }, OTHER_STARTS[1].summary))),
      holder,
    );
    stopDetail = mountGenerate(holder, { signal, onUseResult: (job) => useJobResult(job, signal) });
  }

  renderList();
  await renderDetail();
  const pending = await pendingNewProject();
  if (pending && !signal.aborted) {
    pendingSlot.replaceChildren(
      notice(
        'info',
        el('span', {}, 'The new project ', el('strong', {}, pending.name.trim() || 'Untitled'), ' has not been saved yet.'),
        null,
        el('div', { className: 'notice-actions' }, el('a', { href: `/create/project/${NEW_PROJECT}/properties`, className: 'btn btn-small', id: 'continue-new-project' }, 'Continue editing')),
      ),
    );
  }
  return () => {
    if (typeof stopDetail === 'function') stopDetail();
  };
}

// ── agent job 의 결과 사용 ──────────────────────────────────────────────────

async function fetchJobFile(job, name, as) {
  const response = await fetch(agent.fileUrl(job.id, name));
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
  if (as === 'bytes') return response.arrayBuffer();
  if (as === 'json') return response.json();
  return response.text();
}

/**
 * template.html 은 job 이름의 Project 로 저장하고(같은 이름이 있으면 덮어쓴다), settings.json 은 그 속성과 검수 설정으로,
 * hits.csv 의 첫 행은 표본 행으로 둔다. hits.csv 전체는 그 Project 의 Publish Batch 에 올린 상태로 넘긴다.
 */
async function useJobResult(job, signal) {
  const [html, csvBytes, settingsJson, templates] = await Promise.all([
    fetchJobFile(job, 'template.html', 'text'),
    fetchJobFile(job, 'hits.csv', 'bytes'),
    fetchJobFile(job, 'settings.json', 'json'),
    api.listTemplates(),
  ]);
  if (signal.aborted) return;
  const data = parseCsv(decodeUtf8(csvBytes), 'hits.csv');
  const name = (job.name || job.id).trim();
  const existing = templates.find((t) => t.name === name);
  const settings = applyJobSettings(settingsFromProperties(existing?.properties), settingsJson, data.columns);
  const sample = sampleFor(html, data.rows[0] ?? {});
  const sampleRow = JSON.stringify(sample).length <= SAMPLE_ROW_LIMIT ? sample : {};
  const saved = await api.saveTemplate({ ...(existing ? { id: existing.id } : {}), name, html, properties: settings, sampleRow });
  if (signal.aborted) return;
  // 메모리 사본으로 Publish Batch 에 넘긴다 (IndexedDB 에 다 쓰기를 기다리지 않는다)
  void draftStorage().save({ ...emptyDraft(), templateId: saved.id, data, settings });
  navigate(`/create/publish/${encodeURIComponent(saved.id)}`);
}


// Create → Tutorial (/create/tutorial): Create 를 처음 쓰는 사람이 순서대로 따라 하는 안내 페이지. 위쪽에서 한국어(KR)와 영어(EN)를 고르며,
// 고른 언어는 주소의 ?lang= 과 브라우저에 남는다. 문구는 pages/create/tutorial-content.js 에 있고 여기서는 그리기만 한다.
// 단계마다 그 화면으로 바로 가는 버튼이 있다: 갤러리의 항목을 미리 골라 두고(presetChoice) 이동하거나, 예시 파일을 내려받는다.
// 자동 생성의 예시 prompt(합성 예시 원본과 함께)도 여기서 골라 Generate from raw data 로 넘긴다 (lib/experiments.js).
// 화면별 자세한 설명은 저장소의 docs/create-projects.md 에 있다.

import { agent } from '../../api-client/client.js';
import { el } from '../../components/dom.js';
import { muted } from '../../components/notice.js';
import { requestGenerateExample } from '../../lib/experiments.js';
import { navigate } from '../../router.js';
import { createSubnav, segmented } from './common.js';
import { presetChoice } from './new-project.js';
import { LANGUAGES, LANGUAGE_KEY, TUTORIAL, tutorialLanguage } from './tutorial-content.js';

/** 글(문자열과 표시 토큰의 배열)을 노드로. */
function inline(parts) {
  return parts.map((part) => {
    if (typeof part === 'string') return part;
    if (part.ui !== undefined) return el('code', { className: 'tutorial-ui' }, part.ui);
    if (part.code !== undefined) return el('code', {}, part.code);
    return el('strong', {}, part.strong);
  });
}

function action(item) {
  if (item.download) return el('a', { href: item.download, download: item.file, className: 'btn btn-small', ...(item.id ? { id: item.id } : {}) }, item.label);
  const className = `btn btn-small${item.primary ? ' btn-primary' : ''}`;
  if (item.open) return el('button', { type: 'button', className, dataset: { open: item.open }, onClick: () => navigate(item.open) }, item.label);
  return el(
    'button',
    {
      type: 'button',
      className,
      dataset: { open: item.gallery },
      onClick: () => {
        presetChoice(item.gallery);
        navigate('/create/new/gallery');
      },
    },
    item.label,
  );
}

/**
 * 예시 prompt 를 골라 Generate from raw data 로 넘기는 상자. 예시 목록은 backend 의 /api/agent/models 에서 받는다
 * (prototype 의 mock API 에는 없으므로 그때는 안내만 보인다).
 */
function exampleLoader(text) {
  const holder = el('div', { className: 'tutorial-example', id: 'tutorial-example' }, muted(text.loading));
  agent.listModels().then(
    (models) => {
      if (!holder.isConnected) return; // 그 사이 다른 화면으로 갔다
      const examples = models.prompt_candidates ?? [];
      if (examples.length === 0) {
        holder.replaceChildren(muted(text.empty));
        return;
      }
      const choice = el('select', { id: 'tutorial-example-prompt', 'aria-label': text.label }, examples.map((c) => el('option', { value: c.id }, c.name)));
      const info = muted(examples[0].description || '');
      const status = el('div', { className: 'tutorial-example-status' });
      choice.addEventListener('change', () => { info.textContent = examples.find((c) => c.id === choice.value)?.description || ''; });
      const open = (withData) => {
        const example = examples.find((c) => c.id === choice.value);
        let ok = false;
        try { ok = requestGenerateExample(window.localStorage, window.sessionStorage, example, withData); } catch { ok = false; }
        if (!ok) {
          status.replaceChildren(muted(text.storage));
          return;
        }
        presetChoice('generate');
        navigate('/create/new/gallery');
      };
      holder.replaceChildren(
        el('div', { className: 'field' }, el('label', { for: choice.id }, text.label), choice, info),
        el('div', { className: 'tutorial-actions' },
          el('button', { type: 'button', className: 'btn btn-small', id: 'tutorial-load-prompt', onClick: () => open(false) }, 'Load prompt'),
          el('button', { type: 'button', className: 'btn btn-small btn-primary', id: 'tutorial-load-example', onClick: () => open(true) }, 'Load prompt + example data')),
        status,
      );
    },
    () => holder.replaceChildren(muted(text.unavailable)),
  );
  return holder;
}

/** 흐름 그림: 상자와 화살표. */
function flow(boxes) {
  const parts = [];
  boxes.forEach((box, index) => {
    if (index > 0) parts.push(el('span', { className: 'tutorial-arrow', 'aria-hidden': 'true' }, '→'));
    parts.push(el('div', { className: `tutorial-box${box.accent ? ' accent' : ''}` }, el('strong', {}, box.title), box.text ? el('span', { className: 'muted small' }, box.text) : null));
  });
  return el('div', { className: 'tutorial-flow' }, parts);
}

function block(item, text) {
  if (item.p) return el('p', {}, inline(item.p));
  if (item.note) return el('p', { className: 'muted' }, inline(item.note));
  if (item.flow) return flow(item.flow);
  if (item.subtitle) return el('h4', { className: 'tutorial-subtitle' }, item.subtitle);
  if (item.code) return el('pre', { className: 'pre tutorial-code' }, item.code);
  if (item.actions) return el('div', { className: 'tutorial-actions' }, item.actions.map(action));
  if (item.examples) return exampleLoader(text.examples);
  if (item.steps) return el('ol', { className: 'tutorial-steps' }, item.steps.map((step) => el('li', {}, inline(step))));
  if (item.faq) return el('dl', { className: 'tutorial-faq' }, item.faq.flatMap((entry) => [el('dt', {}, entry.q), el('dd', {}, inline(entry.a))]));
  return el(
    'table',
    { className: 'table tutorial-table' },
    el('thead', {}, el('tr', {}, item.table.head.map((cell) => el('th', {}, inline(cell))))),
    el('tbody', {}, item.table.rows.map((row) => el('tr', {}, row.map((cell) => el('td', {}, inline(cell)))))),
  );
}

function readStored() {
  try {
    return window.localStorage.getItem(LANGUAGE_KEY);
  } catch {
    return null;
  }
}

function writeStored(language) {
  try {
    window.localStorage.setItem(LANGUAGE_KEY, language);
  } catch {
    // 고른 언어를 기억하지 못할 뿐이다
  }
}

export function renderTutorial(root) {
  let language = tutorialLanguage(window.location.search, readStored());
  const body = el('div', { id: 'tutorial-body' });
  const switcher = el('span', { className: 'page-header-right', id: 'tutorial-language' });

  function render() {
    const text = TUTORIAL[language];
    switcher.replaceChildren(
      segmented({
        id: 'tutorial-language-switch',
        options: LANGUAGES,
        value: language,
        onChange: (next) => {
          language = next;
          writeStored(next);
          history.replaceState(null, '', `${window.location.pathname}?lang=${next}`);
          render();
        },
      }),
    );
    body.lang = language;
    body.replaceChildren(
      el(
        'div',
        { className: 'panel tutorial-intro' },
        el('p', {}, text.intro),
        el('nav', { className: 'tutorial-toc', 'aria-label': 'Tutorial' }, text.sections.map((section, index) => el('a', { href: `#${section.id}`, dataset: { external: '' }, onClick: (event) => {
          event.preventDefault();
          document.getElementById(section.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        } }, `${index + 1}. ${section.toc}`))),
      ),
      ...text.sections.map((section, index) =>
        el(
          'section',
          { className: 'panel tutorial-section', id: section.id },
          el('h3', { className: 'panel-title' }, el('span', { className: 'tutorial-number' }, String(index + 1)), section.title),
          section.blocks.map((item) => block(item, text)),
        ),
      ),
    );
  }

  root.append(el('div', { className: 'page-header' }, el('h2', { className: 'page-title' }, 'Create'), switcher), createSubnav('tutorial'), body);
  render();
  return undefined;
}

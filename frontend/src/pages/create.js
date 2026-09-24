// Create: (1) 원본 데이터와 prompt 로 HIT 묶음을 만드는 agent job 패널, (2) job 목록과 진행 카드, (3) 저장된 템플릿 목록.
// job API 는 backend 에만 있다. prototype 의 mock API 는 /api/agent/models 에 404 로 답하므로 그때는 안내를 보이고 폼을 잠근다.
// queued / running 인 job 은 2초마다 getJob 으로 다시 받아 카드를 갱신한다. 페이지를 떠나면 타이머를 멈춘다.

import { agent, api, isApiError } from '../api-client/client.js';
import { jobStatusTag, stepChip, tag } from '../components/badges.js';
import { el } from '../components/dom.js';
import { EMPTY, formatDateTime, formatElapsed, formatNumber } from '../components/format.js';
import { errorNotice, loading, muted, notice } from '../components/notice.js';
import { num, table } from '../components/table.js';

const POLL_MS = 2000;
const LOG_TAIL = 8;
const VISIBLE_PLACEHOLDERS = 6;
const STEP_NAMES = ['profile', 'plan', 'preprocess', 'render', 'validate'];

const isActive = (job) => job.status === 'queued' || job.status === 'running';

export async function render(root, _params, signal) {
  root.append(el('h2', { className: 'page-title' }, 'Create'));

  const generateBody = el('div', { id: 'generate-body' }, loading());
  const jobsBody = el('div', { id: 'job-list' }, loading());
  const templatesBody = el('div', { id: 'template-list' }, loading());
  const refresh = el('button', { type: 'button', className: 'btn btn-small', id: 'refresh-jobs' }, 'Refresh');

  root.append(
    el(
      'section',
      { className: 'panel', id: 'generate-panel' },
      el('h3', { className: 'panel-title' }, 'Generate from raw data'),
      muted('Upload the raw annotation data and a prompt that says what to judge. The pipeline profiles the data, plans a task spec (LLM, or your own task_spec.json), and produces hits.csv and template.html for a batch.'),
      generateBody,
    ),
    el('section', { className: 'panel', id: 'jobs-panel' }, el('div', { className: 'panel-head' }, el('h3', { className: 'panel-title' }, 'Jobs'), refresh), jobsBody),
    el('section', { className: 'panel', id: 'templates-panel' }, el('h3', { className: 'panel-title' }, 'Saved templates'), templatesBody),
  );

  // 폴링 상태. cards 는 job id → 카드 요소, timer 는 다음 폴링 예약
  const state = { cards: new Map(), timer: null, jobs: [] };
  const stop = () => {
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
  };
  signal.addEventListener('abort', stop);

  function upsertJob(job) {
    state.jobs = [job, ...state.jobs.filter((j) => j.id !== job.id)];
    const card = jobCard(job);
    const existing = state.cards.get(job.id);
    if (existing) existing.replaceWith(card);
    else {
      const list = jobsBody.querySelector('.job-list');
      if (list) list.prepend(card);
      else jobsBody.replaceChildren(el('div', { className: 'job-list' }, card));
    }
    state.cards.set(job.id, card);
    schedulePoll();
  }

  function schedulePoll() {
    if (state.timer || signal.aborted) return;
    if (!state.jobs.some(isActive)) return;
    state.timer = setTimeout(async () => {
      state.timer = null;
      await Promise.all(
        state.jobs.filter(isActive).map(async (job) => {
          try {
            const fresh = await agent.getJob(job.id);
            if (!signal.aborted) upsertJob(fresh);
          } catch (error) {
            if (signal.aborted) return;
            // 잠깐의 오류는 다음 폴링에서 다시 시도한다. 사라진 job(404) 은 실패로 표시한다
            if (isApiError(error, 'NOT_FOUND')) upsertJob({ ...job, status: 'failed', error: error.message });
          }
        }),
      );
      if (!signal.aborted) schedulePoll();
    }, POLL_MS);
  }

  async function loadJobs() {
    jobsBody.replaceChildren(loading());
    stop();
    let result;
    try {
      result = await agent.listJobs();
    } catch (error) {
      if (signal.aborted) return;
      jobsBody.replaceChildren(errorNotice(error, 'Jobs'));
      return;
    }
    if (signal.aborted) return;
    state.jobs = result.jobs ?? [];
    state.cards.clear();
    if (state.jobs.length === 0) {
      jobsBody.replaceChildren(muted('No jobs yet. Submit the form above to start one.'));
    } else {
      const list = el('div', { className: 'job-list' });
      for (const job of state.jobs) {
        const card = jobCard(job);
        state.cards.set(job.id, card);
        list.append(card);
      }
      jobsBody.replaceChildren(list);
    }
    schedulePoll();
  }

  refresh.addEventListener('click', () => void loadJobs());

  await Promise.all([renderGenerate(generateBody, jobsBody, upsertJob, loadJobs, signal), renderTemplates(templatesBody, signal)]);
  return stop;
}

// ── Generate 폼 ──────────────────────────────────────────────────────────────

async function renderGenerate(body, jobsBody, upsertJob, loadJobs, signal) {
  let models;
  try {
    models = await agent.listModels();
  } catch (error) {
    if (signal.aborted) return;
    if (isApiError(error, 'NOT_FOUND', 'NOT_IMPLEMENTED')) {
      body.replaceChildren(
        notice(
          'warning',
          'Generate from raw data is not available on this API server',
          `${error.message} — the agent job API (/api/agent/…) exists only in the FastAPI backend. If the frontend is pointed at the prototype mock API (API_UPSTREAM=http://api:8787), start it against the backend instead.`,
        ),
        el('fieldset', { disabled: true, className: 'form form-disabled', id: 'generate-form-disabled' }, generateForm(null).form),
      );
      jobsBody.replaceChildren(muted('The job list needs the same API and is not available here.'));
      return;
    }
    body.replaceChildren(errorNotice(error, 'Models'));
    jobsBody.replaceChildren(muted('The job list could not be loaded because the agent API did not answer.'));
    return;
  }
  if (signal.aborted) return;

  const { form, error: errorSlot, submit } = generateForm(models);
  body.replaceChildren(form);
  void loadJobs();

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorSlot.replaceChildren();
    const data = new FormData();
    const raw = form.elements.raw.files[0];
    const promptFile = form.elements.prompt.files[0];
    const promptText = form.elements.prompt_text.value.trim();
    const spec = form.elements.spec.files[0];
    if (!raw) {
      errorSlot.append(notice('error', 'Raw data file is required'));
      return;
    }
    if (!promptFile && !promptText && !spec) {
      errorSlot.append(notice('error', 'Give a prompt (file or text) or a task_spec.json'));
      return;
    }
    data.append('raw', raw);
    if (promptFile) data.append('prompt', promptFile);
    else if (promptText) data.append('prompt_text', promptText);
    if (spec) data.append('spec', spec);
    if (form.elements.model_config.value) data.append('model_config', form.elements.model_config.value);
    data.append('allow_api', form.elements.allow_api.checked ? 'true' : 'false');
    const name = form.elements.name.value.trim();
    if (name) data.append('name', name);

    submit.disabled = true;
    submit.textContent = 'Submitting…';
    try {
      const result = await agent.createJob(data);
      if (signal.aborted) return;
      upsertJob(result.job);
      form.elements.raw.value = '';
      form.elements.prompt.value = '';
      form.elements.spec.value = '';
      errorSlot.append(notice('success', `Job ${result.job.id} accepted`, 'Progress shows in the Jobs list below.'));
    } catch (error) {
      if (signal.aborted) return;
      errorSlot.append(errorNotice(error, 'Generate'));
    } finally {
      submit.disabled = false;
      submit.textContent = 'Generate';
    }
  });
}

function field(label, control, hint) {
  return el('div', { className: 'field' }, el('label', { for: control.id }, label), control, hint ? el('div', { className: 'hint' }, hint) : null);
}

/** models 가 null 이면 (API 없음) 빈 select 로 잠긴 폼을 그린다. */
function generateForm(models) {
  const modelSelect = el('select', { id: 'gen-model', name: 'model_config' });
  if (models) {
    for (const m of models.models ?? []) {
      const label = `${m.name} — ${m.model}${m.provider_tag ? ` (${m.provider_tag})` : ''}${m.api ? ` · ${m.api}` : ''}`;
      modelSelect.append(el('option', { value: m.name, selected: m.name === models.default }, label));
    }
    if (models.default) modelSelect.value = models.default;
  } else {
    modelSelect.append(el('option', { value: '' }, '(not available)'));
  }
  const apiAllowed = Boolean(models?.api_allowed);
  const allowApi = el('input', { type: 'checkbox', id: 'gen-allow-api', name: 'allow_api', disabled: !apiAllowed });
  const errorSlot = el('div', { className: 'form-error', id: 'generate-error' });
  const submit = el('button', { type: 'submit', className: 'btn btn-primary', id: 'generate-submit' }, 'Generate');

  const form = el(
    'form',
    { className: 'form', id: 'generate-form', enctype: 'multipart/form-data' },
    el(
      'div',
      { className: 'form-grid' },
      field('Name', el('input', { type: 'text', id: 'gen-name', name: 'name', placeholder: 'e.g. groundedness pilot' }), 'Optional. Defaults to the raw file name.'),
      field('Raw data', el('input', { type: 'file', id: 'gen-raw', name: 'raw', accept: '.json,.jsonl,.csv,application/json,text/csv' }), 'JSON, JSONL or CSV. Required.'),
      field('Prompt file', el('input', { type: 'file', id: 'gen-prompt', name: 'prompt', accept: '.md,.txt,text/markdown,text/plain' }), 'prompt.md: annotation goal, data, unit, question and options, HIT composition …'),
      field('Task spec (optional)', el('input', { type: 'file', id: 'gen-spec', name: 'spec', accept: '.json,application/json' }), 'A hand-written task_spec.json skips the LLM planner.'),
    ),
    field('Prompt text', el('textarea', { id: 'gen-prompt-text', name: 'prompt_text', rows: '6', placeholder: 'Or paste the prompt here. Ignored when a prompt file is chosen.' })),
    el(
      'div',
      { className: 'form-grid' },
      field('Model', modelSelect, models ? `Model configs from environment/models/. Default: ${models.default ?? EMPTY}.` : null),
      field(
        'OpenRouter',
        el('label', { className: 'checkbox' }, allowApi, ' Allow API calls (uses credits)'),
        apiAllowed ? 'Allowed on this server (AGENT_ALLOW_API=1). Without it the planner only saves the request.' : 'Disabled on this server (AGENT_ALLOW_API=0): the planner saves the request without calling the API.',
      ),
    ),
    el('div', { className: 'form-actions' }, submit),
    errorSlot,
  );
  return { form, error: errorSlot, submit };
}

// ── Job 카드 ─────────────────────────────────────────────────────────────────

function elapsedOf(job) {
  const start = job.started_at ?? job.created_at;
  if (!start) return null;
  const end = job.finished_at ?? (isActive(job) ? new Date().toISOString() : null);
  if (!end) return null;
  return new Date(end).getTime() - new Date(start).getTime();
}

function kv(label, value) {
  return el('div', { className: 'kv' }, el('span', { className: 'kv-label' }, label), el('span', { className: 'kv-value tabular' }, value));
}

function summaryBlock(summary) {
  if (!summary || typeof summary !== 'object') return null;
  const records = summary.records ?? {};
  const entries = [
    ['Records used', records.used !== undefined ? `${formatNumber(records.used)} / ${formatNumber(records.total)}` : null],
    ['Items', summary.items],
    ['HITs', summary.hits],
    ['Items per HIT', summary.items_per_hit],
    ['Attention items', summary.attention_items],
    ['Targets', summary.targets],
    ['Rows over 64KB', summary.rows_over_64kb],
    ['Columns', Array.isArray(summary.columns) ? summary.columns.length : null],
  ].filter(([, v]) => v !== null && v !== undefined);
  if (entries.length === 0) return el('pre', { className: 'pre' }, JSON.stringify(summary, null, 2));
  return el(
    'div',
    { className: 'job-section' },
    el('div', { className: 'job-section-title' }, 'Summary'),
    el('div', { className: 'kv-grid' }, entries.map(([k, v]) => kv(k, typeof v === 'number' ? formatNumber(v) : String(v)))),
    summary.reference_values ? el('div', { className: 'muted small' }, `Reference values: ${Object.entries(summary.reference_values).map(([k, v]) => `${k} ${v}`).join(', ')}`) : null,
  );
}

function validationBlock(validation) {
  if (!validation || typeof validation !== 'object') return null;
  const errors = validation.errors ?? validation.problems ?? [];
  const warnings = validation.warnings ?? [];
  return el(
    'div',
    { className: 'job-section' },
    el('div', { className: 'job-section-title' }, 'Validation ', validation.ok ? tag('OK', 'green') : tag('FAILED', 'red')),
    errors.length > 0 ? el('ul', { className: 'problem-list' }, errors.map((m) => el('li', { className: 'text-critical' }, String(m)))) : null,
    warnings.length > 0 ? el('ul', { className: 'problem-list' }, warnings.map((m) => el('li', { className: 'text-warning' }, String(m)))) : null,
    errors.length + warnings.length === 0 ? el('div', { className: 'muted small' }, 'No errors or warnings.') : null,
  );
}

function usageBlock(usage) {
  if (!usage) return null;
  const cost = usage.cost === null || usage.cost === undefined ? EMPTY : `$${Number(usage.cost).toFixed(4)}`;
  return el(
    'div',
    { className: 'job-section' },
    el('div', { className: 'job-section-title' }, 'LLM usage'),
    el('div', { className: 'kv-grid' }, kv('Calls', formatNumber(usage.calls)), kv('Prompt tokens', formatNumber(usage.prompt_tokens)), kv('Completion tokens', formatNumber(usage.completion_tokens)), kv('Total tokens', formatNumber(usage.total_tokens)), kv('Cost', cost)),
  );
}

function jobCard(job) {
  const steps = Array.isArray(job.steps) && job.steps.length > 0 ? job.steps : STEP_NAMES.map((name) => ({ name, status: 'pending' }));
  const planner = job.planner ?? {};
  const plannerText =
    planner.mode === 'file'
      ? 'Planner: task_spec.json (no LLM)'
      : `Planner: ${planner.mode ?? EMPTY} · ${planner.model_config ?? EMPTY} · ${planner.allow_api ? 'API allowed' : 'API not allowed (request saved only)'}`;
  const inputs = job.input ? ['raw', 'prompt', 'spec'].filter((k) => job.input[k]).map((k) => `${k}: ${job.input[k]}`).join(' · ') : '';
  const log = Array.isArray(job.log) ? job.log : [];
  const tail = log.slice(-LOG_TAIL);
  const elapsed = elapsedOf(job);

  return el(
    'article',
    { className: `job-card job-${job.status}`, dataset: { jobId: job.id, status: job.status } },
    el(
      'header',
      { className: 'job-head' },
      el('span', { className: 'job-name' }, job.name || job.id),
      jobStatusTag(job.status),
      el('span', { className: 'muted small' }, `Elapsed ${formatElapsed(elapsed)}`),
      el('span', { className: 'muted small job-id' }, job.id),
      el('span', { className: 'muted small' }, `Created ${formatDateTime(job.created_at, true)}`),
    ),
    el('div', { className: 'steps' }, steps.map(stepChip)),
    el('div', { className: 'muted small' }, plannerText, inputs ? ` — ${inputs}` : ''),
    job.error ? notice('error', 'Job failed', job.error) : null,
    summaryBlock(job.summary),
    validationBlock(job.validation),
    usageBlock(job.usage),
    Array.isArray(job.files) && job.files.length > 0
      ? el(
          'div',
          { className: 'job-section' },
          el('div', { className: 'job-section-title' }, 'Files'),
          el('div', { className: 'file-links' }, job.files.map((name) => el('a', { href: agent.fileUrl(job.id, name), download: name, className: 'file-link' }, name))),
        )
      : null,
    job.planner_notes ? el('details', { className: 'job-details' }, el('summary', {}, 'Planner notes'), el('pre', { className: 'pre' }, String(job.planner_notes))) : null,
    log.length > 0
      ? el('details', { className: 'job-details', open: isActive(job) }, el('summary', {}, `Log (last ${tail.length} of ${log.length})`), el('pre', { className: 'pre log' }, tail.join('\n')))
      : null,
  );
}

// ── Saved templates ──────────────────────────────────────────────────────────

const TEMPLATE_COLUMNS = [
  { title: 'Name', width: 260, render: (t) => el('strong', {}, t.name) },
  {
    title: 'Placeholders',
    render: (t) => {
      const names = t.placeholders ?? [];
      const hidden = names.length - VISIBLE_PLACEHOLDERS;
      return [
        ...names.slice(0, VISIBLE_PLACEHOLDERS).map((n) => el('code', { className: 'placeholder' }, `\${${n}}`)),
        hidden > 0 ? el('span', { className: 'muted small', title: names.slice(VISIBLE_PLACEHOLDERS).join(', ') }, `+${hidden} more`) : null,
      ];
    },
  },
  { title: 'Updated', width: 150, render: (t) => formatDateTime(t.updatedAt) },
  { title: 'ID', width: 220, render: (t) => el('code', {}, t.id) },
];

async function renderTemplates(body, signal) {
  let templates;
  try {
    templates = await api.listTemplates();
  } catch (error) {
    if (signal.aborted) return;
    body.replaceChildren(errorNotice(error, 'Templates'));
    return;
  }
  if (signal.aborted) return;
  body.replaceChildren(
    table({ columns: TEMPLATE_COLUMNS, rows: templates, rowKey: (t) => t.id, empty: 'No saved templates.', className: 'template-table' }),
    muted('Templates are saved from the batch wizard. Editing and publishing a batch from here come in a later phase.'),
  );
}

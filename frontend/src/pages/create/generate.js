// Template 단계의 세 번째 방법 `Generate from raw data`: 원본 데이터와 prompt 로 HIT 묶음을 만드는 agent job 패널과 job 목록, 진행 카드.
// job API 는 backend 에만 있다. prototype 의 mock API 는 /api/agent/models 에 404 로 답하므로 그때는 안내를 보이고 폼을 잠근다.
// queued / running 인 job 은 2초마다 getJob 으로 다시 받아 카드를 갱신한다. 패널을 떠나면(stop) 타이머를 멈춘다.
// 성공한 job 의 카드에는 `Use this result` 가 있어 template.html, hits.csv, settings.json 을 마법사에 채운다 (onUseResult).

import { agent, isApiError } from '../../api-client/client.js';
import { jobStatusTag, stepChip, tag } from '../../components/badges.js';
import { el } from '../../components/dom.js';
import { EMPTY, formatDateTime, formatElapsed, formatNumber } from '../../components/format.js';
import { errorNotice, loading, muted, notice } from '../../components/notice.js';
import { failureNotice } from './common.js';

const POLL_MS = 2000;
const LOG_TAIL = 8;
const STEP_NAMES = ['profile', 'plan', 'preprocess', 'render', 'validate'];
export const RESULT_FILES = ['template.html', 'hits.csv', 'settings.json'];

const isActive = (job) => job.status === 'queued' || job.status === 'running';

/** 결과 세 파일이 모두 있는 성공한 job 인지 */
export function hasResult(job) {
  return job.status === 'succeeded' && Array.isArray(job.files) && RESULT_FILES.every((name) => job.files.includes(name));
}

/**
 * root 에 패널을 그린다. { signal, onUseResult(job) } — signal 이 abort 되면 폴링을 멈춘다. stop() 을 돌려준다.
 */
export function mountGenerate(root, { signal, onUseResult }) {
  const generateBody = el('div', { id: 'generate-body' }, loading());
  const jobsBody = el('div', { id: 'job-list' }, loading());
  const refresh = el('button', { type: 'button', className: 'btn btn-small', id: 'refresh-jobs' }, 'Refresh');

  root.append(
    el(
      'div',
      { className: 'generate-panel', id: 'generate-panel' },
      muted('Upload the raw annotation data and a prompt that says what to judge. The pipeline profiles the data, plans a task spec (LLM, or your own task_spec.json), and produces hits.csv and template.html for a batch. When a job succeeds, "Use this result" fills the Template, Data and Settings steps.'),
      generateBody,
    ),
    el('div', { className: 'jobs-panel', id: 'jobs-panel' }, el('div', { className: 'panel-head' }, el('h4', { className: 'section-title' }, 'Jobs'), refresh), jobsBody),
  );

  // 폴링 상태. cards 는 job id → 카드 요소, timer 는 다음 폴링 예약
  const state = { cards: new Map(), timer: null, jobs: [], stopped: false };
  const stop = () => {
    state.stopped = true;
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
  };
  signal.addEventListener('abort', stop);
  const gone = () => state.stopped || signal.aborted;

  function upsertJob(job) {
    state.jobs = [job, ...state.jobs.filter((j) => j.id !== job.id)];
    const card = jobCard(job, onUseResult);
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
    if (state.timer || gone()) return;
    if (!state.jobs.some(isActive)) return;
    state.timer = setTimeout(async () => {
      state.timer = null;
      await Promise.all(
        state.jobs.filter(isActive).map(async (job) => {
          try {
            const fresh = await agent.getJob(job.id);
            if (!gone()) upsertJob(fresh);
          } catch (error) {
            if (gone()) return;
            // 잠깐의 오류는 다음 폴링에서 다시 시도한다. 사라진 job(404) 은 실패로 표시한다
            if (isApiError(error, 'NOT_FOUND')) upsertJob({ ...job, status: 'failed', error: error.message });
          }
        }),
      );
      if (!gone()) schedulePoll();
    }, POLL_MS);
  }

  async function loadJobs() {
    jobsBody.replaceChildren(loading());
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    let result;
    try {
      result = await agent.listJobs();
    } catch (error) {
      if (gone()) return;
      jobsBody.replaceChildren(errorNotice(error, 'Jobs'));
      return;
    }
    if (gone()) return;
    state.jobs = result.jobs ?? [];
    state.cards.clear();
    if (state.jobs.length === 0) {
      jobsBody.replaceChildren(muted('No jobs yet. Submit the form above to start one.'));
    } else {
      const list = el('div', { className: 'job-list' });
      for (const job of state.jobs) {
        const card = jobCard(job, onUseResult);
        state.cards.set(job.id, card);
        list.append(card);
      }
      jobsBody.replaceChildren(list);
    }
    schedulePoll();
  }

  refresh.addEventListener('click', () => void loadJobs());

  void renderGenerate(generateBody, jobsBody, upsertJob, loadJobs, gone);
  return stop;
}

// ── Generate 폼 ──────────────────────────────────────────────────────────────

async function renderGenerate(body, jobsBody, upsertJob, loadJobs, gone) {
  let models;
  try {
    models = await agent.listModels();
  } catch (error) {
    if (gone()) return;
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
  if (gone()) return;

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
      if (gone()) return;
      upsertJob(result.job);
      form.elements.raw.value = '';
      form.elements.prompt.value = '';
      form.elements.spec.value = '';
      errorSlot.append(notice('success', `Job ${result.job.id} accepted`, 'Progress shows in the Jobs list below.'));
    } catch (error) {
      if (gone()) return;
      errorSlot.append(errorNotice(error, 'Generate'));
    } finally {
      submit.disabled = false;
      submit.textContent = 'Generate';
    }
  });
}

function formField(label, control, hint) {
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
      formField('Name', el('input', { type: 'text', id: 'gen-name', name: 'name', placeholder: 'e.g. groundedness pilot' }), 'Optional. Defaults to the raw file name. The template saved by "Use this result" gets this name.'),
      formField('Raw data', el('input', { type: 'file', id: 'gen-raw', name: 'raw', accept: '.json,.jsonl,.csv,application/json,text/csv' }), 'JSON, JSONL or CSV. Required.'),
      formField('Prompt file', el('input', { type: 'file', id: 'gen-prompt', name: 'prompt', accept: '.md,.txt,text/markdown,text/plain' }), 'prompt.md: annotation goal, data, unit, question and options, HIT composition …'),
      formField('Task spec (optional)', el('input', { type: 'file', id: 'gen-spec', name: 'spec', accept: '.json,application/json' }), 'A hand-written task_spec.json skips the LLM planner.'),
    ),
    formField('Prompt text', el('textarea', { id: 'gen-prompt-text', name: 'prompt_text', rows: '6', placeholder: 'Or paste the prompt here. Ignored when a prompt file is chosen.' })),
    el(
      'div',
      { className: 'form-grid' },
      formField('Model', modelSelect, models ? `Model configs from environment/models/. Default: ${models.default ?? EMPTY}.` : null),
      formField(
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

/** 성공한 job 의 결과를 마법사에 채우는 버튼. 실패하면 카드 안에 이유를 보인다. */
function useResultBlock(job, onUseResult) {
  if (!hasResult(job) || !onUseResult) return null;
  const errorSlot = el('div', { className: 'use-result-error' });
  const button = el('button', { type: 'button', className: 'btn btn-primary btn-small use-result', dataset: { jobId: job.id } }, 'Use this result');
  button.addEventListener('click', async () => {
    errorSlot.replaceChildren();
    button.disabled = true;
    button.textContent = 'Loading…';
    try {
      await onUseResult(job);
    } catch (error) {
      errorSlot.append(failureNotice('Could not use this result', error));
      button.disabled = false;
      button.textContent = 'Use this result';
    }
  });
  return el(
    'div',
    { className: 'job-section use-result-section' },
    el('div', { className: 'use-result-row' }, button, el('span', { className: 'muted small' }, 'Saves template.html as a template, loads hits.csv as the data and fills the settings from settings.json.')),
    errorSlot,
  );
}

function jobCard(job, onUseResult) {
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
    useResultBlock(job, onUseResult),
    job.planner_notes ? el('details', { className: 'job-details' }, el('summary', {}, 'Planner notes'), el('pre', { className: 'pre' }, String(job.planner_notes))) : null,
    log.length > 0
      ? el('details', { className: 'job-details', open: isActive(job) }, el('summary', {}, `Log (last ${tail.length} of ${log.length})`), el('pre', { className: 'pre log' }, tail.join('\n')))
      : null,
  );
}

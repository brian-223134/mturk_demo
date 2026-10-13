// New Project 의 `Generate from raw data`: 원본 데이터와 prompt 로 HIT 묶음을 만드는 agent job 패널과 Templates 목록.
// job API 는 backend 에만 있다. prototype 의 mock API 는 /api/agent/models 에 404 로 답하므로 그때는 안내를 보이고 폼을 잠근다.
// prompt 로 만들면 후보 3개가 한 묶음(job group)으로 동시에 돌고, Templates 에는 묶음 카드 하나로 보인다. 모두 끝나면
// `Compare and choose` 로 후보를 나란히 비교하고 하나를 고른다. 고른 후보는 template.html 과 settings.json 을 Project 로 저장하고
// hits.csv 를 그 Project 의 Publish Batch 에 올린다 (onUseResult, pages/create/new-project.js). task spec 으로 돌린 job 과
// 묶음이 생기기 전의 job 은 예전처럼 job 카드 하나로 보이고 `Use this result` 가 있다.
// queued / running 인 job 은 2초마다 getJob 으로 다시 받아 카드를 갱신한다. 패널을 떠나면(stop) 타이머를 멈춘다.

import { agent, isApiError } from '../../api-client/client.js';
import { jobStatusTag, stepChip, tag } from '../../components/badges.js';
import { el } from '../../components/dom.js';
import { EMPTY, formatDateTime, formatElapsed, formatNumber } from '../../components/format.js';
import { errorNotice, loading, muted, notice } from '../../components/notice.js';
import { toast } from '../../components/toast.js';
import { candidateLabel, candidateLetter, entryKey, groupJobs, groupMessage, groupState } from '../../lib/job-groups.js';
import { failureNotice } from './common.js';
import { mountGenerateForm } from './generate-form.js';
import { openJobResults } from './job-results.js';

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
  const listBody = el('div', { id: 'job-list' }, loading());
  const selected = new Set();
  const compare = el('button', { type: 'button', className: 'btn btn-small', id: 'compare-jobs', disabled: true }, 'Compare selected (0)');
  let formReady;
  const actions = {
    reuse: async (job) => (await formReady)?.reuse(job),
    preview: (job) => openJobResults([job], upsertJob),
    compareGroup: (jobs) => openJobResults(jobs, upsertJob, { onChoose: chooseCandidate }),
    selected,
    select: (job, checked) => { if (checked) selected.add(job.id); else selected.delete(job.id); updateCompare(); },
  };
  function updateCompare() {
    compare.textContent = `Compare selected (${selected.size})`;
    compare.disabled = selected.size < 2 || selected.size > 3;
  }
  compare.addEventListener('click', () => openJobResults(state.jobs.filter((job) => selected.has(job.id)), upsertJob));
  const refresh = el('button', { type: 'button', className: 'btn btn-small', id: 'refresh-jobs' }, 'Refresh');

  root.append(
    el(
      'div',
      { className: 'generate-panel', id: 'generate-panel' },
      muted('Upload the raw annotation data and a prompt that says what to judge. Generate runs three candidates at once: each asks a different model to plan a task spec, and the pipeline turns every spec into hits.csv and template.html. When they finish, compare the candidates and choose one. The chosen layout is saved as a project and Publish Batch opens with its hits.csv.'),
      generateBody,
    ),
    el(
      'div',
      { className: 'jobs-panel', id: 'jobs-panel' },
      el('div', { className: 'panel-head' }, el('h4', { className: 'section-title' }, 'Templates'), el('span', { className: 'muted small' }, 'Or select 2–3 from different runs'), compare, refresh),
      listBody,
    ),
  );

  // 폴링 상태. cards 는 화면 항목의 key(group id 또는 job id) → 카드 요소, timer 는 다음 폴링 예약,
  // watched 는 이 화면에서 접수한 묶음 (끝나면 알린다)
  const state = { cards: new Map(), timer: null, jobs: [], stopped: false, watched: new Set() };
  const stop = () => {
    state.stopped = true;
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
  };
  signal.addEventListener('abort', stop);
  const gone = () => state.stopped || signal.aborted;

  function entryCard(entry) {
    return entry.kind === 'group' ? groupCard(entry.jobs, actions) : jobCard(entry.job, onUseResult, actions);
  }

  function renderEntry(key) {
    const entry = groupJobs(state.jobs).find((e) => e.key === key);
    if (!entry) return;
    const card = entryCard(entry);
    const existing = state.cards.get(key);
    if (existing) {
      keepDetailsState(existing, card);
      existing.replaceWith(card);
    } else {
      const list = listBody.querySelector('.job-list');
      if (list) list.prepend(card);
      else listBody.replaceChildren(el('div', { className: 'job-list' }, card));
    }
    state.cards.set(key, card);
    if (entry.kind === 'group') announceFinished(entry);
  }

  function announceFinished(entry) {
    if (!state.watched.has(entry.groupId)) return;
    const summary = groupState(entry.jobs, hasResult);
    if (summary.status === 'running') return;
    state.watched.delete(entry.groupId);
    const name = entry.jobs[0].name;
    if (summary.status === 'ready') toast.success(`Candidates for "${name}" are ready. Compare them in Templates and choose one.`);
    else toast.warning(`Every candidate for "${name}" failed. Open a candidate in Templates to see why.`);
  }

  /** job 들을 상태에 넣고 그 job 이 속한 화면 항목만 다시 그린다. 새 job 은 목록 맨 위에 붙는다. */
  function upsertJobs(jobs) {
    if (gone()) return;
    const keys = new Set();
    for (const job of jobs) {
      const index = state.jobs.findIndex((j) => j.id === job.id);
      if (index >= 0) state.jobs[index] = job;
      else state.jobs.unshift(job);
      keys.add(entryKey(job));
    }
    for (const key of keys) renderEntry(key);
    schedulePoll();
  }

  function upsertJob(job) {
    upsertJobs([job]);
  }

  /** 묶음에서 후보 하나를 골랐다고 기록하고 그 결과로 Project 를 만든다. 실패하면 비교 창이 이유를 보인다. */
  async function chooseCandidate(job) {
    const { jobs } = await agent.chooseCandidate(job.group.id, job.id);
    upsertJobs(jobs);
    await onUseResult(jobs.find((j) => j.id === job.id) ?? job);
  }

  function schedulePoll() {
    if (state.timer || gone()) return;
    if (!state.jobs.some(isActive)) return;
    state.timer = setTimeout(async () => {
      state.timer = null;
      const fresh = await Promise.all(
        state.jobs.filter(isActive).map(async (job) => {
          try {
            return await agent.getJob(job.id);
          } catch (error) {
            // 잠깐의 오류는 다음 폴링에서 다시 시도한다. 사라진 job(404) 은 실패로 표시한다
            return isApiError(error, 'NOT_FOUND') ? { ...job, status: 'failed', error: error.message } : null;
          }
        }),
      );
      if (gone()) return;
      upsertJobs(fresh.filter(Boolean));
      schedulePoll();
    }, POLL_MS);
  }

  async function loadJobs() {
    listBody.replaceChildren(loading());
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    let result;
    try {
      result = await agent.listJobs();
    } catch (error) {
      if (gone()) return;
      listBody.replaceChildren(errorNotice(error, 'Templates'));
      return;
    }
    if (gone()) return;
    state.jobs = result.jobs ?? [];
    for (const id of selected) if (!state.jobs.some((job) => job.id === id && hasResult(job))) selected.delete(id);
    updateCompare();
    state.cards.clear();
    const entries = groupJobs(state.jobs);
    if (entries.length === 0) {
      listBody.replaceChildren(muted('No templates yet. Submit the form above to generate candidates.'));
    } else {
      const list = el('div', { className: 'job-list' });
      for (const entry of entries) {
        const card = entryCard(entry);
        state.cards.set(entry.key, card);
        list.append(card);
      }
      listBody.replaceChildren(list);
    }
    schedulePoll();
  }

  refresh.addEventListener('click', () => void loadJobs());

  const onCreated = (jobs) => {
    for (const job of jobs) if (job.group) state.watched.add(job.group.id);
    upsertJobs(jobs);
  };
  formReady = renderGenerate(generateBody, listBody, onCreated, loadJobs, gone);
  return stop;
}

/** 다시 그린 카드에서도 사용자가 열어 둔(또는 닫은) details 를 그대로 둔다. data-key 가 같은 것끼리 맞춘다. */
function keepDetailsState(oldNode, newNode) {
  const open = new Map([...oldNode.querySelectorAll('details[data-key]')].map((d) => [d.dataset.key, d.open]));
  for (const details of newNode.querySelectorAll('details[data-key]')) {
    if (open.has(details.dataset.key)) details.open = open.get(details.dataset.key);
  }
}

// ── Generate 폼 ──────────────────────────────────────────────────────────────

async function renderGenerate(body, listBody, onCreated, loadJobs, gone) {
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
      );
      listBody.replaceChildren(muted('The template list needs the same API and is not available here.'));
      return;
    }
    body.replaceChildren(errorNotice(error, 'Models'));
    listBody.replaceChildren(muted('The template list could not be loaded because the agent API did not answer.'));
    return;
  }
  if (gone()) return;

  const controller = mountGenerateForm(body, models, { onCreated, gone });
  void loadJobs();
  return controller;
}

// ── 카드의 조각 ──────────────────────────────────────────────────────────────

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

function stepsOf(job) {
  return Array.isArray(job.steps) && job.steps.length > 0 ? job.steps : STEP_NAMES.map((name) => ({ name, status: 'pending' }));
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
    ['Targets incl. attention', summary.targets],
    ['Missing reference labels', summary.hints_missing],
    ['Skipped empty items', summary.skipped_no_targets],
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

function costText(usage) {
  return usage?.cost === null || usage?.cost === undefined ? EMPTY : `$${Number(usage.cost).toFixed(4)}`;
}

function usageBlock(usage) {
  if (!usage) return null;
  return el(
    'div',
    { className: 'job-section' },
    el('div', { className: 'job-section-title' }, 'LLM usage'),
    el('div', { className: 'kv-grid' }, kv('Calls', formatNumber(usage.calls)), kv('Prompt tokens', formatNumber(usage.prompt_tokens)), kv('Completion tokens', formatNumber(usage.completion_tokens)), kv('Total tokens', formatNumber(usage.total_tokens)), kv('Cost', costText(usage))),
  );
}

function filesBlock(job) {
  if (!Array.isArray(job.files) || job.files.length === 0) return null;
  return el(
    'div',
    { className: 'job-section' },
    el('div', { className: 'job-section-title' }, 'Files'),
    el('div', { className: 'file-links' }, job.files.map((name) => el('a', { href: agent.fileUrl(job.id, name), download: name, className: 'file-link' }, name))),
  );
}

function notesAndLog(job) {
  const log = Array.isArray(job.log) ? job.log : [];
  const tail = log.slice(-LOG_TAIL);
  return [
    job.planner_notes ? el('details', { className: 'job-details', dataset: { key: `notes-${job.id}` } }, el('summary', {}, 'Planner notes'), el('pre', { className: 'pre' }, String(job.planner_notes))) : null,
    log.length > 0
      ? el('details', { className: 'job-details', open: isActive(job), dataset: { key: `log-${job.id}` } }, el('summary', {}, `Log (last ${tail.length} of ${log.length})`), el('pre', { className: 'pre log' }, tail.join('\n')))
      : null,
  ];
}

function compareCheckbox(job, actions) {
  return hasResult(job)
    ? el('label', { className: 'checkbox' }, el('input', { type: 'checkbox', className: 'compare-job', checked: actions.selected.has(job.id), onChange: (event) => actions.select(job, event.target.checked) }), ' Compare')
    : null;
}

// ── 후보 묶음 카드 ───────────────────────────────────────────────────────────

function groupStatusTag(summary) {
  if (summary.status === 'running') return jobStatusTag('running');
  if (summary.status === 'failed') return jobStatusTag('failed');
  return summary.chosen ? tag('chosen', 'green', { className: 'job-status' }) : tag('ready', 'success', { className: 'job-status' });
}

function candidateTile(job, chosen, actions) {
  const summary = job.summary ?? {};
  const quick = [
    ['HITs', summary.hits],
    ['Items', summary.items],
    ['Attention', summary.attention_items],
    ['Cost', job.usage ? costText(job.usage) : null],
  ].filter(([, v]) => v !== null && v !== undefined);
  return el(
    'section',
    { className: `candidate-tile job-${job.status}${chosen ? ' candidate-chosen' : ''}`, dataset: { jobId: job.id, status: job.status } },
    el('div', { className: 'candidate-head' }, el('strong', {}, `Candidate ${candidateLetter(job.group.index)}`), jobStatusTag(job.status), chosen ? tag('Chosen', 'green') : null),
    el('div', { className: 'muted small' }, `${job.planner?.model_config ?? EMPTY} · Elapsed ${formatElapsed(elapsedOf(job))}`),
    el('div', { className: 'steps' }, stepsOf(job).map(stepChip)),
    quick.length > 0 ? el('div', { className: 'kv-grid' }, quick.map(([k, v]) => kv(k, typeof v === 'number' ? formatNumber(v) : String(v)))) : null,
    job.error ? notice('error', 'Candidate failed', job.error) : null,
    compareCheckbox(job, actions),
    el(
      'details',
      { className: 'job-details', dataset: { key: `detail-${job.id}` } },
      el('summary', {}, 'Details'),
      el('div', { className: 'muted small job-id' }, job.id),
      summaryBlock(job.summary),
      validationBlock(job.validation),
      usageBlock(job.usage),
      filesBlock(job),
      ...notesAndLog(job),
    ),
  );
}

function groupCard(jobs, actions) {
  const summary = groupState(jobs, hasResult);
  const first = jobs[0];
  const compareLabel = summary.ready.length > 1 ? `Compare and choose (${summary.ready.length})` : 'Preview and choose';
  const compareButton = el(
    'button',
    { type: 'button', className: 'btn btn-primary btn-small compare-group', disabled: summary.status !== 'ready', onClick: () => actions.compareGroup(summary.ready) },
    compareLabel,
  );
  const cost = jobs.reduce((sum, job) => sum + (typeof job.usage?.cost === 'number' ? job.usage.cost : 0), 0);
  return el(
    'article',
    { className: `job-card job-group group-${summary.status}`, dataset: { groupId: first.group.id, status: summary.status } },
    el(
      'header',
      { className: 'job-head' },
      el('span', { className: 'job-name' }, first.name || first.group.id),
      groupStatusTag(summary),
      el('span', { className: 'muted small' }, `${jobs.length} candidates`),
      cost > 0 ? el('span', { className: 'muted small' }, `LLM cost $${cost.toFixed(4)}`) : null,
      el('span', { className: 'muted small job-id' }, first.group.id),
      el('span', { className: 'muted small' }, `Created ${formatDateTime(first.created_at, true)}`),
    ),
    el('div', { className: 'candidate-grid' }, jobs.map((job) => candidateTile(job, summary.chosen?.id === job.id, actions))),
    el(
      'div',
      { className: 'form-actions group-actions' },
      compareButton,
      el('button', { type: 'button', className: 'btn btn-small reuse-inputs', onClick: () => void actions.reuse(first) }, 'Reuse inputs'),
      el('span', { className: 'muted small group-message' }, groupMessage(summary)),
    ),
  );
}

// ── 단독 job 카드 (task spec 으로 돌린 job, 묶음이 생기기 전의 job) ─────────────

/** 성공한 job 의 결과로 Project 를 만들고 Publish Batch 로 가는 버튼. 실패하면 카드 안에 이유를 보인다. */
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
    el('div', { className: 'use-result-row' }, button, el('span', { className: 'muted small' }, 'Saves template.html and settings.json as a project named after the job (replacing a project with the same name), then opens Publish Batch with hits.csv.')),
    errorSlot,
  );
}

function jobCard(job, onUseResult, actions) {
  const planner = job.planner ?? {};
  const plannerText =
    planner.mode === 'file'
      ? 'Planner: task_spec.json (no LLM)'
      : `Planner: ${planner.mode ?? EMPTY} · ${planner.model_config ?? EMPTY} · ${planner.allow_api ? 'API allowed' : 'API not allowed'}`;
  const inputs = job.input ? ['raw', 'prompt', 'spec'].filter((k) => job.input[k]).map((k) => `${k}: ${job.input[k]}`).join(' · ') : '';

  return el(
    'article',
    { className: `job-card job-${job.status}`, dataset: { jobId: job.id, status: job.status } },
    el(
      'header',
      { className: 'job-head' },
      el('span', { className: 'job-name' }, candidateLabel(job)),
      jobStatusTag(job.status),
      el('span', { className: 'muted small' }, `Elapsed ${formatElapsed(elapsedOf(job))}`),
      el('span', { className: 'muted small job-id' }, job.id),
      el('span', { className: 'muted small' }, `Created ${formatDateTime(job.created_at, true)}`),
    ),
    el('div', { className: 'steps' }, stepsOf(job).map(stepChip)),
    el('div', { className: 'muted small' }, plannerText, inputs ? ` — ${inputs}` : ''),
    job.error ? notice('error', 'Job failed', job.error) : null,
    el('div', { className: 'form-actions job-actions' },
      el('button', { type: 'button', className: 'btn btn-small reuse-inputs', onClick: () => void actions.reuse(job) }, 'Reuse inputs'),
      hasResult(job) ? el('button', { type: 'button', className: 'btn btn-small preview-result', onClick: () => actions.preview(job) }, 'Preview & evaluate') : null,
      compareCheckbox(job, actions),
      tag(job.review?.decision || 'unreviewed', job.review?.decision === 'shortlisted' ? 'green' : 'default'),
    ),
    summaryBlock(job.summary),
    validationBlock(job.validation),
    usageBlock(job.usage),
    filesBlock(job),
    useResultBlock(job, onUseResult),
    ...notesAndLog(job),
  );
}

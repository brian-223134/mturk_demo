// Generate from raw data 의 입력 폼. prompt 로 만들면 후보 3개(모델만 다른 job 묶음, POST /api/agent/job-groups)를 한꺼번에 접수하고,
// task spec 을 주면 planner 를 건너뛰므로 job 하나(POST /api/agent/jobs)만 만든다.
import { agent } from '../../api-client/client.js';
import { el } from '../../components/dom.js';
import { errorNotice, muted, notice } from '../../components/notice.js';
import { normalizeGenerateDraft, readGenerateDraft, saveGenerateDraft } from '../../lib/experiments.js';
import { CANDIDATE_COUNT, candidateLetter, defaultCandidateModels, repeatedModels, restoreCandidateModels } from '../../lib/job-groups.js';

function field(label, control, hint) {
  return el('div', { className: 'field' }, el('label', { for: control.id }, label), control, hint ? muted(hint) : null);
}

export function mountGenerateForm(root, models, { onCreated, gone }) {
  let storage;
  try { storage = window.localStorage; } catch { storage = null; }
  let draft = storage ? readGenerateDraft(storage) : normalizeGenerateDraft(null);
  let source = draft.source;
  let busy = false;
  let importedRaw = null;
  const name = el('input', { id: 'gen-name', name: 'name', type: 'text', value: draft.name });
  const raw = el('input', { id: 'gen-raw', name: 'raw', type: 'file', accept: '.json,.jsonl,.csv' });
  const prompt = el('textarea', { id: 'gen-prompt-text', name: 'prompt_text', rows: 12, value: draft.prompt_text });
  const spec = el('input', { id: 'gen-spec', name: 'spec', type: 'file', accept: '.json' });
  const modelOptions = () => models.models.map((m) => el('option', { value: m.name }, `${m.name} — ${m.model}`));
  const modelSelects = Array.from({ length: CANDIDATE_COUNT }, (_, i) =>
    el('select', { id: `gen-model-${i}`, name: 'model_configs', className: 'candidate-model', 'aria-label': `Model for candidate ${candidateLetter(i)}` }, modelOptions()));
  const setModels = (names) => modelSelects.forEach((select, i) => { select.value = names[i] ?? ''; });
  setModels(restoreCandidateModels(draft.model_configs, models.models, models.default));
  const modelWarning = el('div', { id: 'gen-model-warning' });
  const modelField = el('div', { className: 'field', id: 'gen-models' },
    el('span', { className: 'field-label' }, 'Models for the candidates'),
    el('div', { className: 'candidate-models' }, modelSelects.map((select, i) =>
      el('label', { className: 'candidate-model-field', for: select.id }, el('span', { className: 'candidate-letter' }, `Candidate ${candidateLetter(i)}`), select))),
    muted(`Generate runs ${CANDIDATE_COUNT} candidates at the same time from the same raw data and prompt. Each candidate asks its model to write the task spec, and you compare the results and choose one. Every model runs at temperature 0, so the same model twice gives nearly the same candidate.`),
    modelWarning);
  const allow = el('input', { id: 'gen-allow-api', name: 'allow_api', type: 'checkbox', disabled: !models.api_allowed });
  const reuseSpec = el('input', { id: 'gen-reuse-spec', type: 'checkbox' });
  const reuseLabel = el('label', { className: 'checkbox' }, reuseSpec, ' Reuse the saved task spec (skips the planner)');
  const rawStatus = el('div', { className: 'muted small', id: 'gen-raw-status' });
  const specStatus = el('div', { id: 'gen-spec-status' });
  const errorSlot = el('div', { id: 'generate-error' });
  const storageStatus = el('div', { className: 'muted small' });
  const submit = el('button', { type: 'submit', id: 'generate-submit', className: 'btn btn-primary' }, 'Generate');
  const reset = el('button', { type: 'button', className: 'btn', id: 'gen-clear' }, 'Clear inputs');
  const examples = models.prompt_candidates || [];
  const example = el('select', { id: 'gen-candidate' }, examples.map((c) => el('option', { value: c.id }, c.name)));
  const exampleInfo = muted(examples[0]?.description || '');
  example.addEventListener('change', () => { exampleInfo.textContent = examples.find((c) => c.id === example.value)?.description || ''; });
  const loadCandidate = el('button', { type: 'button', className: 'btn btn-small', id: 'gen-load-candidate', onClick: () => applyCandidate(examples.find((c) => c.id === example.value)) }, 'Load prompt');
  const loadExample = el('button', { type: 'button', className: 'btn btn-small', id: 'gen-load-example' }, 'Load prompt + example data');
  const fields = el('fieldset', { className: 'generate-fields' },
    examples.length ? el('div', { className: 'field' }, el('label', { for: example.id }, 'Example prompts'), example, exampleInfo,
      el('div', { className: 'form-actions' }, loadCandidate, loadExample), muted('All four example prompts use the same six-record example and HIT policy. Loading one replaces the prompt and clears any task spec.')) : null,
    field('Name', name, 'The candidates share this name. The project you create from the chosen candidate gets it too, replacing a project with the same name.'),
    field('Raw data', raw, 'JSON, JSONL or CSV. A selected file replaces any reused raw data.'), rawStatus,
    field('Prompt text', prompt),
    modelField,
    el('label', { className: 'checkbox' }, allow, ' Allow API calls (uses credits)'),
    muted(models.api_allowed ? 'API permission is required for each session unless a task spec is supplied.' : 'LLM calls are disabled on this server. Set AGENT_ALLOW_API=1 in environment/.env and restart the backend to enable them, or use a task spec for an offline run.'),
    el('details', {}, el('summary', {}, 'Optional task spec · offline replay'), field('Task spec', spec),
      el('button', { type: 'button', className: 'btn btn-small', onClick: () => { spec.value = ''; reuseSpec.checked = false; refresh(); } }, 'Clear spec'), reuseLabel),
    specStatus, el('div', { className: 'form-actions' }, submit, reset));
  const form = el('form', { className: 'form', id: 'generate-form' }, fields, storageStatus, errorSlot);
  root.replaceChildren(form);

  const specMode = () => Boolean(spec.files[0] || (reuseSpec.checked && source?.has_spec));

  function applyCandidate(value, rawFile = null) {
    if (!value || busy || fields.disabled) return;
    prompt.value = value.prompt_text; name.value = value.name;
    spec.value = ''; reuseSpec.checked = false;
    if (rawFile) { raw.value = ''; importedRaw = rawFile; source = null; }
    errorSlot.replaceChildren(); refresh();
  }
  loadExample.addEventListener('click', async () => {
    const value = examples.find((c) => c.id === example.value);
    fields.disabled = true;
    try {
      const response = await fetch(agent.exampleRawUrl);
      if (!response.ok) throw new Error(`Example data: HTTP ${response.status}`);
      const rawFile = new File([await response.blob()], 'raw.json', { type: 'application/json' });
      if (!gone()) { fields.disabled = false; applyCandidate(value, rawFile); }
    } catch (error) { if (!gone()) errorSlot.replaceChildren(errorNotice(error, 'Example')); }
    finally { if (!gone()) fields.disabled = busy; }
  });

  function persist() {
    draft = { name: name.value, prompt_text: prompt.value, model_configs: modelSelects.map((s) => s.value), source };
    const saved = storage && saveGenerateDraft(storage, draft);
    storageStatus.textContent = saved ? 'Prompt and settings are saved in this browser. Local files must be reselected after reload; submitted raw data can be reused.' : 'Browser draft storage is unavailable. Keep a copy of your prompt before leaving.';
  }
  function refresh() {
    rawStatus.textContent = raw.files[0] ? `Selected: ${raw.files[0].name}` : importedRaw ? `Example: ${importedRaw.name}` : source ? `Reusing ${source.raw_name} from ${source.source_job_id}` : 'No raw data selected.';
    reuseLabel.hidden = !source?.has_spec;
    if (!source?.has_spec) reuseSpec.checked = false;
    const offline = specMode();
    for (const select of modelSelects) select.disabled = offline;
    const repeated = repeatedModels(modelSelects.map((s) => s.value));
    modelWarning.replaceChildren(...(!offline && repeated.length ? [notice('warning', `${repeated.join(', ')} is chosen more than once`, 'Those candidates will be nearly identical. Choose different models to get different task specs.')] : []));
    specStatus.replaceChildren(...(offline ? [notice('warning', 'Saved spec mode', 'The planner is skipped, so one job is generated instead of three candidates and no model is called. Changes to the prompt do not affect this run. Clear the spec to generate candidates.')] : []));
    submit.textContent = offline ? 'Generate' : `Generate ${CANDIDATE_COUNT} candidates`;
    persist();
  }
  for (const control of [name, prompt]) control.addEventListener('input', persist);
  for (const select of modelSelects) select.addEventListener('change', refresh);
  raw.addEventListener('change', () => { importedRaw = null; refresh(); });
  spec.addEventListener('change', () => { reuseSpec.checked = false; refresh(); });
  reuseSpec.addEventListener('change', refresh);
  reset.addEventListener('click', () => {
    name.value = ''; prompt.value = ''; raw.value = ''; spec.value = '';
    source = null; importedRaw = null; reuseSpec.checked = false; allow.checked = false;
    setModels(defaultCandidateModels(models.models, models.default));
    errorSlot.replaceChildren(); refresh();
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy) return;
    errorSlot.replaceChildren();
    const chosenRaw = raw.files[0] || importedRaw;
    if (!chosenRaw && !source) { errorSlot.append(notice('error', 'Choose raw data or reuse an earlier run.')); return; }
    const fileSpec = spec.files[0];
    const offline = specMode();
    if (!offline && !prompt.value.trim()) { errorSlot.append(notice('error', 'Enter a prompt or supply a task spec.')); return; }
    if (!offline && (!models.api_allowed || !allow.checked)) {
      errorSlot.append(notice('error', 'LLM calls are not enabled', models.api_allowed ? 'Check Allow API calls to run this prompt.' : 'Start the backend with API calls enabled, or supply a task spec for an offline run.')); return;
    }
    if (!offline && modelSelects.some((s) => !s.value)) { errorSlot.append(notice('error', 'Choose a model for every candidate.')); return; }
    const data = new FormData();
    if (chosenRaw) data.append('raw', chosenRaw, chosenRaw.name);
    if (source) data.append('source_job_id', source.source_job_id);
    if (fileSpec) data.append('spec', fileSpec);
    else if (offline) data.append('reuse_spec', 'true');
    data.append('prompt_text', prompt.value);
    data.append('name', name.value.trim());
    data.append('allow_api', allow.checked ? 'true' : 'false');
    if (!offline) for (const select of modelSelects) data.append('model_configs', select.value);
    busy = true; fields.disabled = true; submit.textContent = 'Submitting…';
    try {
      const result = offline ? await agent.createJob(data) : await agent.createJobGroup(data);
      if (gone()) return;
      const jobs = result.jobs ?? [result.job];
      const first = jobs[0];
      source = { source_job_id: first.id, raw_name: first.input.raw, has_spec: Boolean(first.input.spec) };
      raw.value = ''; importedRaw = null;
      // Uploaded specs remain selected; reusing a spec from a past job is always explicit.
      refresh(); onCreated(jobs);
      errorSlot.replaceChildren(offline
        ? notice('success', 'Run accepted', 'Raw data is ready to reuse. Edit the prompt and name for the next run.')
        : notice('success', `${jobs.length} candidates accepted`, 'They run at the same time. When they finish, compare them in Templates below and choose one.'));
    } catch (error) { if (!gone()) errorSlot.replaceChildren(errorNotice(error, 'Generate')); }
    finally { busy = false; if (!gone()) { fields.disabled = false; refresh(); } }
  });
  refresh();
  return {
    async reuse(job) {
      if (busy || fields.disabled) return;
      fields.disabled = true;
      try {
        const inputs = await agent.getJobInputs(job.id);
        if (gone()) return;
        source = inputs; importedRaw = null; raw.value = ''; spec.value = ''; reuseSpec.checked = false; allow.checked = false;
        name.value = `${inputs.name} · variant`; prompt.value = inputs.prompt_text;
        refresh();
        errorSlot.replaceChildren(notice('info', 'Inputs restored', inputs.has_spec ? 'Raw data and prompt restored. To replay the saved spec, enable Reuse the saved task spec under Optional task spec.' : 'Edit the prompt and name, then explicitly allow the next API call.'));
        root.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } catch (error) { if (!gone()) errorSlot.replaceChildren(errorNotice(error, 'Restore inputs')); }
      finally { if (!gone()) fields.disabled = false; }
    },
    applyCandidate,
  };
}

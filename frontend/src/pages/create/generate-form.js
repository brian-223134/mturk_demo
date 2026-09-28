import { agent } from '../../api-client/client.js';
import { el } from '../../components/dom.js';
import { errorNotice, muted, notice } from '../../components/notice.js';
import { normalizeGenerateDraft, readGenerateDraft, saveGenerateDraft } from '../../lib/experiments.js';

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
  const promptFile = el('input', { id: 'gen-prompt', name: 'prompt', type: 'file', accept: '.md,.txt' });
  const prompt = el('textarea', { id: 'gen-prompt-text', name: 'prompt_text', rows: 12, value: draft.prompt_text });
  const spec = el('input', { id: 'gen-spec', name: 'spec', type: 'file', accept: '.json' });
  const model = el('select', { id: 'gen-model', name: 'model_config' }, models.models.map((m) => el('option', { value: m.name }, `${m.name} — ${m.model}`)));
  model.value = models.models.some((m) => m.name === draft.model_config) ? draft.model_config : models.default;
  const allow = el('input', { id: 'gen-allow-api', name: 'allow_api', type: 'checkbox', disabled: !models.api_allowed });
  const reuseSpec = el('input', { id: 'gen-reuse-spec', type: 'checkbox' });
  const reuseLabel = el('label', { className: 'checkbox' }, reuseSpec, ' Reuse the saved task spec (skips the planner)');
  const rawStatus = el('div', { className: 'muted small', id: 'gen-raw-status' });
  const specStatus = el('div', { id: 'gen-spec-status' });
  const errorSlot = el('div', { id: 'generate-error' });
  const storageStatus = el('div', { className: 'muted small' });
  const submit = el('button', { type: 'submit', id: 'generate-submit', className: 'btn btn-primary' }, 'Generate');
  const reset = el('button', { type: 'button', className: 'btn', id: 'gen-clear' }, 'Clear inputs');
  const candidates = models.prompt_candidates || [];
  const candidate = el('select', { id: 'gen-candidate' }, candidates.map((c) => el('option', { value: c.id }, c.name)));
  const candidateInfo = muted(candidates[0]?.description || '');
  candidate.addEventListener('change', () => { candidateInfo.textContent = candidates.find((c) => c.id === candidate.value)?.description || ''; });
  const loadCandidate = el('button', { type: 'button', className: 'btn btn-small', id: 'gen-load-candidate', onClick: () => applyCandidate(candidates.find((c) => c.id === candidate.value)) }, 'Load prompt');
  const loadExample = el('button', { type: 'button', className: 'btn btn-small', id: 'gen-load-example' }, 'Load prompt + example data');
  const fields = el('fieldset', { className: 'generate-fields' },
    candidates.length ? el('div', { className: 'field' }, el('label', { for: candidate.id }, 'Example prompt candidates'), candidate, candidateInfo,
      el('div', { className: 'form-actions' }, loadCandidate, loadExample), muted('All four candidates use the same six-record example and HIT policy. Loading a candidate replaces the prompt and clears any task spec.')) : null,
    field('Candidate name', name, 'Use a distinct name for each prompt version.'),
    field('Raw data', raw, 'JSON, JSONL or CSV. A selected file replaces any reused raw data.'), rawStatus,
    field('Import prompt file', promptFile, 'Loads the file into the editable prompt below.'),
    field('Prompt text', prompt),
    field('Model', model),
    el('label', { className: 'checkbox' }, allow, ' Allow API calls (uses credits)'),
    muted(models.api_allowed ? 'API permission is required for each session unless a task spec is supplied.' : 'LLM calls are disabled on this server. Use a task spec for an offline run.'),
    el('details', {}, el('summary', {}, 'Optional task spec · offline replay'), field('Task spec', spec),
      el('button', { type: 'button', className: 'btn btn-small', onClick: () => { spec.value = ''; reuseSpec.checked = false; refresh(); } }, 'Clear spec'), reuseLabel),
    specStatus, el('div', { className: 'form-actions' }, submit, reset));
  const form = el('form', { className: 'form', id: 'generate-form' }, fields, storageStatus, errorSlot);
  root.replaceChildren(form);

  function applyCandidate(value, rawFile = null) {
    if (!value || busy || fields.disabled) return;
    prompt.value = value.prompt_text; name.value = value.name;
    spec.value = ''; reuseSpec.checked = false;
    if (rawFile) { raw.value = ''; importedRaw = rawFile; source = null; }
    errorSlot.replaceChildren(); refresh();
  }
  loadExample.addEventListener('click', async () => {
    const value = candidates.find((c) => c.id === candidate.value);
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
    draft = { name: name.value, prompt_text: prompt.value, model_config: model.value, source };
    const saved = storage && saveGenerateDraft(storage, draft);
    storageStatus.textContent = saved ? 'Prompt and settings are saved in this browser. Local files must be reselected after reload; submitted raw data can be reused.' : 'Browser draft storage is unavailable. Keep a copy of your prompt before leaving.';
  }
  function refresh() {
    rawStatus.textContent = raw.files[0] ? `Selected: ${raw.files[0].name}` : importedRaw ? `Example: ${importedRaw.name}` : source ? `Reusing ${source.raw_name} from ${source.source_job_id}` : 'No raw data selected.';
    reuseLabel.hidden = !source?.has_spec;
    if (!source?.has_spec) reuseSpec.checked = false;
    specStatus.replaceChildren(...(spec.files[0] || reuseSpec.checked ? [notice('warning', 'Saved spec mode', 'The planner is skipped. Changes to the prompt do not affect this run. Clear the spec to compare prompts.')] : []));
    persist();
  }
  for (const control of [name, prompt, model]) control.addEventListener('input', persist);
  raw.addEventListener('change', () => { importedRaw = null; refresh(); });
  spec.addEventListener('change', () => { reuseSpec.checked = false; refresh(); });
  reuseSpec.addEventListener('change', refresh);
  promptFile.addEventListener('change', async () => {
    const file = promptFile.files[0];
    if (!file) return;
    fields.disabled = true;
    try { const text = await file.text(); if (!gone()) { prompt.value = text; persist(); } }
    catch (error) { if (!gone()) errorSlot.replaceChildren(errorNotice(error, 'Prompt')); }
    finally { if (!gone()) { promptFile.value = ''; fields.disabled = busy; } }
  });
  reset.addEventListener('click', () => {
    name.value = ''; prompt.value = ''; raw.value = ''; promptFile.value = ''; spec.value = '';
    source = null; importedRaw = null; reuseSpec.checked = false; allow.checked = false;
    errorSlot.replaceChildren(); refresh();
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy) return;
    errorSlot.replaceChildren();
    const chosenRaw = raw.files[0] || importedRaw;
    if (!chosenRaw && !source) { errorSlot.append(notice('error', 'Choose raw data or reuse an earlier run.')); return; }
    const fileSpec = spec.files[0];
    const savedSpec = reuseSpec.checked && source?.has_spec;
    if (!fileSpec && !savedSpec && !prompt.value.trim()) { errorSlot.append(notice('error', 'Enter a prompt or supply a task spec.')); return; }
    if (!fileSpec && !savedSpec && (!models.api_allowed || !allow.checked)) {
      errorSlot.append(notice('error', 'LLM calls are not enabled', models.api_allowed ? 'Check Allow API calls to run this prompt.' : 'Start the backend with API calls enabled, or supply a task spec for an offline run.')); return;
    }
    const data = new FormData();
    if (chosenRaw) data.append('raw', chosenRaw, chosenRaw.name);
    if (source) data.append('source_job_id', source.source_job_id);
    if (fileSpec) data.append('spec', fileSpec);
    else if (savedSpec) data.append('reuse_spec', 'true');
    data.append('prompt_text', prompt.value);
    data.append('name', name.value.trim());
    data.append('model_config', model.value);
    data.append('allow_api', allow.checked ? 'true' : 'false');
    busy = true; fields.disabled = true; submit.textContent = 'Submitting…';
    try {
      const { job } = await agent.createJob(data);
      if (gone()) return;
      source = { source_job_id: job.id, raw_name: job.input.raw, has_spec: Boolean(job.input.spec) };
      raw.value = ''; importedRaw = null;
      // Uploaded specs remain selected; reusing a spec from a past job is always explicit.
      refresh(); onCreated(job);
      errorSlot.replaceChildren(notice('success', 'Run accepted', 'Raw data is ready to reuse. Edit the prompt and candidate name for the next run.'));
    } catch (error) { if (!gone()) errorSlot.replaceChildren(errorNotice(error, 'Generate')); }
    finally { busy = false; if (!gone()) { fields.disabled = false; submit.textContent = 'Generate'; } }
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
        const modelAvailable = !inputs.model_config || models.models.some((m) => m.name === inputs.model_config);
        if (inputs.model_config && modelAvailable) model.value = inputs.model_config;
        refresh();
        errorSlot.replaceChildren(notice('info', 'Inputs restored', inputs.has_spec ? 'Raw data and prompt restored. To replay the saved spec, enable Reuse the saved task spec under Optional task spec.' : 'Edit the prompt and name, then explicitly allow the next API call.'));
        if (!modelAvailable) errorSlot.append(notice('warning', 'The saved model is no longer available. Choose a model before running.'));
        root.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } catch (error) { if (!gone()) errorSlot.replaceChildren(errorNotice(error, 'Restore inputs')); }
      finally { if (!gone()) fields.disabled = false; }
    },
    applyCandidate,
  };
}

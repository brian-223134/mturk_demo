import { agent } from '../../api-client/client.js';
import { el } from '../../components/dom.js';
import { openModal } from '../../components/modal.js';
import { errorNotice, loading, muted, notice } from '../../components/notice.js';
import { previewFrame } from '../../components/preview-frame.js';
import { downloadFile } from '../../components/download.js';
import { parseCsv, decodeUtf8 } from '../../lib/csv.js';
import { comparisonWarnings, sharedRows, experimentReport } from '../../lib/experiments.js';

async function resultFile(job, name, type, signal) {
  const response = await fetch(agent.fileUrl(job.id, name), { signal });
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
  return type === 'bytes' ? response.arrayBuffer() : type === 'json' ? response.json() : response.text();
}

export async function loadBundle(job, signal) {
  const [html, csv, spec, inputs] = await Promise.all([
    resultFile(job, 'template.html', 'text', signal), resultFile(job, 'hits.csv', 'bytes', signal),
    resultFile(job, 'task_spec.json', 'json', signal), agent.getJobInputs(job.id),
  ]);
  const data = parseCsv(decodeUtf8(csv), 'hits.csv');
  if (!data.rows.length) throw new Error('The result contains no HIT rows.');
  return { job, html, data, spec, inputs };
}

function select(values, value, label) {
  const control = el('select', { 'aria-label': label }, values.map(([key, text]) => el('option', { value: key }, text)));
  control.value = value;
  return control;
}

function reviewForm(bundle, onSaved, gone) {
  const review = bundle.job.review || {};
  const decision = select([['unreviewed', 'Unreviewed'], ['shortlisted', 'Shortlisted'], ['rejected', 'Rejected']], review.decision || 'unreviewed', 'Candidate decision');
  const checks = {};
  const fields = ['data', 'instructions', 'attention'].map((key) => {
    checks[key] = select([['unchecked', 'Unchecked'], ['pass', 'Pass'], ['fail', 'Fail']], review.checks?.[key] || 'unchecked', `${key} quality`);
    return el('label', { className: 'field' }, key === 'data' ? 'Data and labels' : key === 'instructions' ? 'Worker instructions' : 'Attention validity', checks[key]);
  });
  const notes = el('textarea', { rows: 4, maxLength: 10000, 'aria-label': 'Evaluation notes', value: review.notes || '' });
  const status = el('div', { className: 'muted small', role: 'status' });
  const save = el('button', { type: 'button', className: 'btn btn-primary btn-small' }, 'Save evaluation');
  save.addEventListener('click', async () => {
    save.disabled = true; status.textContent = 'Saving…';
    try {
      const job = await agent.reviewJob(bundle.job.id, { decision: decision.value, notes: notes.value, checks: Object.fromEntries(Object.entries(checks).map(([k, v]) => [k, v.value])) });
      bundle.job = job;
      if (gone()) return;
      onSaved(job); status.textContent = 'Saved. This evaluation is separate from structural validation.';
    } catch (error) { if (!gone()) status.textContent = error.message; }
    finally { if (!gone()) save.disabled = false; }
  });
  return el('div', { className: 'job-evaluation' }, el('h4', {}, 'Quality evaluation'),
    el('label', { className: 'field' }, 'Decision', decision), el('div', { className: 'evaluation-checks' }, fields),
    el('label', { className: 'field' }, 'Notes', notes), save, status);
}

function metrics(bundles) {
  const rows = [
    ['Status', (b) => b.job.status], ['Planner', (b) => b.job.planner?.mode], ['Model', (b) => b.job.planner?.model_config || 'Saved spec'],
    ['Records used', (b) => `${b.job.summary?.records?.used ?? '—'} / ${b.job.summary?.records?.total ?? '—'}`],
    ['HITs', (b) => b.data.rows.length], ['General items', (b) => b.job.summary?.items],
    ['Targets incl. attention', (b) => b.job.summary?.targets], ['Missing labels', (b) => b.job.summary?.hints_missing],
    ['Skipped empty items', (b) => b.job.summary?.skipped_no_targets],
    ['Sampling', (b) => JSON.stringify(b.spec.source?.sample ?? null)],
    ['Attention', (b) => JSON.stringify(b.spec.hit?.attention ?? null)],
    ['Structural validation', (b) => b.job.validation?.ok ? 'Passed' : 'Failed'],
    ['LLM calls', (b) => b.job.usage?.calls ?? 0], ['Cost (USD)', (b) => b.job.usage?.cost ?? '—'],
  ];
  return el('div', { className: 'table-scroll' }, el('table', { className: 'experiment-table' },
    el('thead', {}, el('tr', {}, el('th', {}, 'Measure'), bundles.map((b) => el('th', {}, b.job.name)))),
    el('tbody', {}, rows.map(([label, value]) => el('tr', {}, el('th', {}, label), bundles.map((b) => el('td', {}, String(value(b) ?? '—'))))))));
}

export function openJobResults(jobs, onSaved = () => {}) {
  const controller = new AbortController();
  let closed = false;
  const frames = new Map();
  const body = el('div', {}, loading());
  openModal({ title: jobs.length > 1 ? 'Compare prompt candidates' : `Result · ${jobs[0].name}`, width: jobs.length > 1 ? 1440 : 1160,
    className: 'modal-experiments', content: body,
    onClose: () => { closed = true; controller.abort(); frames.forEach((frame) => frame.destroy()); },
  });
  const gone = () => closed;
  Promise.all(jobs.map((job) => loadBundle(job, controller.signal))).then((bundles) => {
    if (closed) return;
    const warnings = comparisonWarnings(bundles);
    const shared = sharedRows(bundles);
    const panels = [];
    const rowControls = [];
    const previews = [];
    function showRow(i, rowIndex) {
      frames.get(i)?.destroy();
      const index = Math.min(Math.max(0, rowIndex), bundles[i].data.rows.length - 1);
      rowControls[i].value = String(index);
      const frame = previewFrame({ html: bundles[i].html, row: bundles[i].data.rows[index], height: 620 });
      frames.set(i, frame); previews[i].replaceChildren(frame.node);
    }
    bundles.forEach((b, i) => {
      const rows = b.data.rows.map((row, index) => [String(index), `Row ${index + 1} · ${String(row.record_ids || '').slice(0, 95)}`]);
      rowControls[i] = select(rows, '0', `Preview row for ${b.job.name}`);
      rowControls[i].addEventListener('change', () => { if (common) common.value = ''; showRow(i, Number(rowControls[i].value)); });
      previews[i] = el('div', { className: 'job-preview' });
      panels.push(el('section', { className: 'experiment-candidate', dataset: { jobId: b.job.id } }, el('h4', {}, b.job.name),
        muted(b.job.id),
        el('details', {}, el('summary', {}, 'Requester prompt'), el('pre', { className: 'pre experiment-spec' }, b.inputs.prompt_text || '(No prompt)')),
        el('details', {}, el('summary', {}, 'Task spec'), el('pre', { className: 'pre experiment-spec' }, JSON.stringify(b.spec, null, 2))),
        el('label', { className: 'field' }, 'Preview row', rowControls[i]), previews[i], reviewForm(b, onSaved, gone)));
    });
    const common = bundles.length > 1 && shared.length ? select([['', 'Choose a common group'], ...shared.map((row, i) => [String(i), `Group ${i + 1} · ${JSON.parse(row.key)[0][0]}`])], '0', 'Common general items') : null;
    if (common) common.addEventListener('change', () => { if (common.value !== '') shared[Number(common.value)].indexes.forEach((index, i) => showRow(i, index)); });
    const download = el('button', { type: 'button', className: 'btn btn-small', onClick: () => downloadFile({ filename: 'prompt-comparison.json', mimeType: 'application/json', content: JSON.stringify(experimentReport(bundles), null, 2) }) }, 'Export comparison JSON');
    body.replaceChildren(
      notice('info', 'Structural validation and quality are separate', 'Inspect the data, instructions and attention checks. Preview submissions are displayed here; worker responses are not stored.'),
      ...warnings.map((warning) => notice('warning', warning)), metrics(bundles),
      el('div', { className: 'form-actions' }, download, muted('Export includes saved evaluations and prompts. Save notes before exporting.')),
      ...(common ? [el('label', { className: 'field' }, 'Preview the same general items in every candidate', common), muted('Matched by record and item IDs; attention items may differ.')] : bundles.length > 1 ? [notice('warning', 'No unambiguous common item group', 'Rows are selected independently. These previews are not aligned.')] : []),
      el('div', { className: 'experiment-grid', style: { gridTemplateColumns: `repeat(${bundles.length}, minmax(0, 1fr))` } }, panels));
    bundles.forEach((_, i) => showRow(i, shared[0]?.indexes[i] ?? 0));
  }).catch((error) => { if (!closed) body.replaceChildren(errorNotice(error, 'Results')); });
}

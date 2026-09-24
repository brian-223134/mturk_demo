// Create (3) Settings: HIT 설정, Qualification 세 가지, worker pool 포함/제외, attention rule, Review 의 대조 기준.
// 입력은 draft.settings 에 바로 쓰고(다시 그리지 않아 커서가 유지된다), Next 를 누를 때 lib/settings.js 의 validateSettings 로 검사한다.

import { el } from '../../components/dom.js';
import { errorNotice, notice } from '../../components/notice.js';
import { FEE_PERCENT_10_OR_MORE, HIGH_FEE_MIN_ASSIGNMENTS, formatCents, rewardToCents } from '../../lib/cost.js';
import { MAX_AUTO_APPROVAL_DAYS, MIN_REWARD, describeReferenceCell, estimateFor, normalizeCountries, normalizeReward, validateSettings } from '../../lib/settings.js';
import { field, sectionTitle, stepFooter } from './common.js';

// 케이스 스터디의 worker 가 주로 있던 곳과 MTurk 에서 흔히 쓰는 영어권 국가. 다른 코드는 직접 입력한다.
const COMMON_COUNTRIES = [
  ['US', 'United States'],
  ['CA', 'Canada'],
  ['GB', 'United Kingdom'],
  ['AU', 'Australia'],
  ['NZ', 'New Zealand'],
  ['IE', 'Ireland'],
  ['IN', 'India'],
  ['KR', 'South Korea'],
];

const MAJORITY_LABEL = 'Majority of the other workers on the same HIT';

export function renderSettingsStep(ctx) {
  const { draft, pools, poolsError } = ctx;
  const columns = draft.data?.columns ?? [];
  const fields = {}; // 필드 이름 → field 노드 (오류 문구를 보이려고)
  const set = (patch) => ctx.update((current) => ({ settings: { ...current.settings, ...patch } }), { rerender: false });
  const s = () => ctx.draft.settings;

  function textInput(name, attrs = {}) {
    const input = el('input', { type: 'text', id: `s-${name}`, name, value: s()[name] ?? '', ...attrs });
    input.addEventListener('input', () => set({ [name]: input.value }));
    return input;
  }

  /** 숫자 입력. 비어 있거나 숫자가 아니면 NaN 으로 두어 검증이 걸러 낸다. integer 면 정수로 읽는다. */
  function numberInput(name, attrs = {}, { integer = false, onChange } = {}) {
    const input = el('input', { type: 'number', id: `s-${name}`, name, value: String(s()[name] ?? ''), ...attrs });
    const read = () => {
      const text = input.value.trim();
      if (text === '') return Number.NaN;
      return integer ? (Number.isInteger(Number(text)) ? Number(text) : Number.NaN) : Number(text);
    };
    input.addEventListener('input', () => {
      set({ [name]: read() });
      if (onChange) onChange();
    });
    return input;
  }

  // ── What workers see in the HIT list ──
  const title = textInput('Title', { maxlength: 128 });
  const description = el('textarea', { id: 's-Description', name: 'Description', rows: 2, maxlength: 2000 });
  description.value = s().Description;
  description.addEventListener('input', () => set({ Description: description.value }));
  const keywords = textInput('Keywords', { maxlength: 1000 });

  // ── Payment and timing ──
  const feeNotice = el('div', { id: 'fee-notice' });
  const costLine = el('div', { className: 'settings-cost', id: 'settings-cost' });
  const reward = el('input', { type: 'number', id: 's-Reward', name: 'Reward', value: s().Reward, min: MIN_REWARD, step: '0.01' });
  reward.addEventListener('input', () => {
    set({ Reward: reward.value });
    refreshCost();
  });
  reward.addEventListener('change', () => {
    // "0.1" → "0.10" 처럼 두 자리로 맞춘다
    if (reward.value.trim() !== '' && Number.isFinite(Number.parseFloat(reward.value))) {
      reward.value = normalizeReward(reward.value);
      set({ Reward: reward.value });
      refreshCost();
    }
  });
  const maxAssignments = numberInput('MaxAssignments', { min: 1, max: 1000, step: 1 }, { integer: true, onChange: refreshCost });
  const duration = numberInput('durationMinutes', { min: 1, max: 525600, step: 1 });
  const lifetime = numberInput('lifetimeDays', { min: 1, max: 365, step: 1 });
  const autoApproval = numberInput('autoApprovalDays', { min: 1, max: MAX_AUTO_APPROVAL_DAYS, step: 1 });

  function refreshCost() {
    const v = s();
    feeNotice.replaceChildren();
    if (Number.isInteger(v.MaxAssignments) && v.MaxAssignments >= HIGH_FEE_MIN_ASSIGNMENTS) {
      feeNotice.append(notice('info', `With MaxAssignments of ${HIGH_FEE_MIN_ASSIGNMENTS} or more, the MTurk fee becomes ${FEE_PERCENT_10_OR_MORE}% of the reward.`));
    }
    const rows = ctx.draft.data?.rows.length ?? 0;
    const estimate = estimateFor(v, rows);
    costLine.replaceChildren();
    if (!estimate) {
      costLine.append(el('span', { className: 'text-critical' }, 'The cost cannot be estimated: check Reward and MaxAssignments.'));
      return;
    }
    costLine.append(
      el('span', { className: 'muted' }, 'Cost preview: '),
      el('span', { className: 'tabular' }, `${rows.toLocaleString('en-US')} HITs × ${v.MaxAssignments} assignments × ${formatCents(rewardToCents(v.Reward))} = reward ${formatCents(estimate.rewardCents)} + fee (${estimate.feePercent}%) ${formatCents(estimate.feeCents)} = `),
      el('strong', { className: 'tabular', id: 'settings-total' }, formatCents(estimate.totalCents)),
      el('span', { className: 'muted' }, '. Details in the next step.'),
    );
  }

  // ── Qualification requirements ──
  function qualificationRow(enabledName, label, valueControl, syncEnabled) {
    const checkbox = el('input', { type: 'checkbox', id: `s-${enabledName}`, name: enabledName, checked: Boolean(s()[enabledName]) });
    checkbox.addEventListener('change', () => {
      set({ [enabledName]: checkbox.checked });
      syncEnabled(checkbox.checked);
    });
    syncEnabled(checkbox.checked);
    return el('div', { className: 'qual-row' }, el('label', { className: 'checkbox qual-label', for: `s-${enabledName}` }, checkbox, ` ${label}`), valueControl);
  }
  const approvalRate = numberInput('approvalRate', { min: 0, max: 100, step: 1 }, { integer: true });
  const approvedHits = numberInput('approvedHits', { min: 0, max: 10000000, step: 1 }, { integer: true });
  const countries = el('input', { type: 'text', id: 's-countries', name: 'countries', value: s().countries.join(', '), list: 'country-codes', placeholder: 'US, CA, GB … (type any two-letter code)' });
  countries.addEventListener('input', () => set({ countries: normalizeCountries(countries.value) }));
  countries.addEventListener('change', () => {
    const codes = normalizeCountries(countries.value);
    set({ countries: codes });
    countries.value = codes.join(', ');
  });
  const datalist = el('datalist', { id: 'country-codes' }, COMMON_COUNTRIES.map(([code, name]) => el('option', { value: code }, `${code} – ${name}`)));
  fields.approvalRate = field({ id: 's-approvalRate', control: el('div', { className: 'suffix-input' }, approvalRate, el('span', { className: 'suffix' }, '%')), className: 'field-inline' });
  fields.approvedHits = field({ id: 's-approvedHits', control: approvedHits, className: 'field-inline' });
  fields.countries = field({ id: 's-countries', control: [countries, datalist], className: 'field-inline field-grow', hint: 'Comma or space separated ISO 3166 codes.' });

  // ── Worker pools ──
  function poolList(name, otherName, label, hint, placeholder) {
    const list = el('div', { className: 'pool-list', id: `s-${name}` });
    const sync = () => {
      const mine = new Set(s()[name]);
      const other = new Set(s()[otherName]);
      for (const box of list.querySelectorAll('input[type=checkbox]')) {
        box.checked = mine.has(box.value);
        box.disabled = other.has(box.value);
      }
    };
    for (const pool of pools ?? []) {
      const box = el('input', { type: 'checkbox', value: pool.id, name, id: `s-${name}-${pool.id}` });
      box.addEventListener('change', () => {
        const current = s()[name].filter((id) => id !== pool.id);
        set({ [name]: box.checked ? [...current, pool.id] : current });
        poolSyncs.forEach((fn) => fn());
      });
      const count = pool.workerIds?.length ?? 0;
      list.append(el('label', { className: 'checkbox pool-option', for: `s-${name}-${pool.id}` }, box, ` ${pool.name} (${count} worker${count === 1 ? '' : 's'})`));
    }
    if ((pools ?? []).length === 0) list.append(el('span', { className: 'muted' }, placeholder));
    poolSyncs.push(sync);
    return field({ id: `s-${name}`, label, control: list, hint });
  }
  const poolSyncs = [];
  fields.requiredPoolIds = poolList('requiredPoolIds', 'excludedPoolIds', 'Only workers in', 'Leave empty to allow everyone who meets the qualification requirements.', 'No pools yet (any worker).');
  fields.excludedPoolIds = poolList('excludedPoolIds', 'requiredPoolIds', 'Exclude workers in', null, 'No pools yet (nobody excluded).');
  poolSyncs.forEach((fn) => fn());

  // ── Attention check ──
  const attentionSwitch = el('input', { type: 'checkbox', id: 's-attentionEnabled', name: 'attentionEnabled', className: 'switch', role: 'switch', checked: s().attentionEnabled });
  const attentionFields = el('div', { className: 'field-row', id: 'attention-fields' });
  const attentionOff = el('p', { className: 'muted', id: 'attention-off' }, 'Without a rule, Review shows no attention result and nothing can be selected by “attention failed”.');
  const syncAttention = () => {
    attentionFields.hidden = !s().attentionEnabled;
    attentionOff.hidden = s().attentionEnabled;
  };
  attentionSwitch.addEventListener('change', () => {
    set({ attentionEnabled: attentionSwitch.checked });
    syncAttention();
  });
  fields.attentionPrefix = field({ id: 's-attentionPrefix', label: 'Answer name prefix', control: textInput('attentionPrefix', { placeholder: 'attention_' }), hint: 'Answers whose name starts with this prefix are attention checks. All other answers are real questions.' });
  fields.attentionExpected = field({ id: 's-attentionExpected', label: 'Expected value', control: textInput('attentionExpected', { placeholder: 'e.g. not_grounded' }), hint: 'The answer value that counts as correct. It differs by template: not_grounded, Not Covered, not_covered …' });
  fields.attentionMinRatio = field({ id: 's-attentionMinRatio', label: 'Minimum correct ratio', control: numberInput('attentionMinRatio', { min: 0, max: 1, step: 0.05 }), hint: 'An assignment passes when correct attention answers / all attention answers is at least this value. 1 means all of them.' });
  attentionFields.append(fields.attentionPrefix, fields.attentionExpected, fields.attentionMinRatio);
  syncAttention();

  // ── Review reference ──
  const referenceSelect = el('select', { id: 's-referenceColumn', name: 'referenceColumn' }, el('option', { value: '' }, MAJORITY_LABEL), columns.map((c) => el('option', { value: c }, `Input column: ${c}`)));
  const current = s().referenceColumn;
  if (current && !columns.includes(current)) referenceSelect.append(el('option', { value: current }, `Input column: ${current} (not in the CSV)`));
  referenceSelect.value = current ?? '';
  const referenceNote = el('div', { id: 'reference-note' });
  const syncReference = () => {
    referenceNote.replaceChildren();
    const column = s().referenceColumn;
    if (column && ctx.draft.data && columns.includes(column)) {
      const note = describeReferenceCell(ctx.draft.data.rows[0]?.[column] ?? '');
      referenceNote.append(notice(note.type, note.message));
    }
  };
  referenceSelect.addEventListener('change', () => {
    set({ referenceColumn: referenceSelect.value || null });
    syncReference();
  });
  syncReference();

  fields.Title = field({ id: 's-Title', label: 'Title', control: title, required: true });
  fields.Description = field({ id: 's-Description', label: 'Description', control: description, required: true });
  fields.Keywords = field({ id: 's-Keywords', label: 'Keywords', control: keywords, hint: 'Comma separated.' });
  fields.Reward = field({ id: 's-Reward', label: 'Reward per assignment', control: el('div', { className: 'prefix-input' }, el('span', { className: 'prefix' }, '$'), reward), required: true });
  fields.MaxAssignments = field({ id: 's-MaxAssignments', label: 'MaxAssignments', control: maxAssignments, hint: 'Number of workers (labels) per HIT.', required: true });
  fields.durationMinutes = field({ id: 's-durationMinutes', label: 'Time allotted', control: el('div', { className: 'suffix-input' }, duration, el('span', { className: 'suffix' }, 'minutes')), hint: 'How long a worker has to finish one assignment.', required: true });
  fields.lifetimeDays = field({ id: 's-lifetimeDays', label: 'HIT lifetime', control: el('div', { className: 'suffix-input' }, lifetime, el('span', { className: 'suffix' }, 'days')), hint: 'How long the HITs stay available to workers.', required: true });
  fields.autoApprovalDays = field({ id: 's-autoApprovalDays', label: 'Auto-approval delay', control: el('div', { className: 'suffix-input' }, autoApproval, el('span', { className: 'suffix' }, 'days')), hint: `Submissions not reviewed within this time are approved automatically. At most ${MAX_AUTO_APPROVAL_DAYS} days.`, required: true });
  fields.referenceColumn = field({ id: 's-referenceColumn', label: 'Compare answers with', control: referenceSelect, hint: "Review shows this next to each worker's answers. Choose a CSV column that holds ground truth or LLM labels; keep the default when the CSV has no such column.", className: 'field-wide' });

  refreshCost();

  // 고치기 시작하면 그 항목의 오류 문구는 지운다 (다음 Next 에서 다시 검사한다)
  const clearFieldError = (event) => {
    const owner = event.target.closest('.field');
    if (owner && typeof owner.setError === 'function') owner.setError('');
  };

  function next() {
    const errors = validateSettings(s(), { columns, pools: pools ?? [] });
    for (const [name, node] of Object.entries(fields)) node.setError(errors[name] ?? '');
    const first = Object.keys(errors).find((name) => fields[name]);
    if (first) {
      fields[first].scrollIntoView({ block: 'center', behavior: 'smooth' });
      const control = fields[first].querySelector('input, select, textarea');
      if (control && !control.disabled) control.focus({ preventScroll: true });
      return;
    }
    ctx.goTo(3);
  }

  const node = el(
    'section',
    { className: 'panel step', id: 'step-settings' },
    el('h3', { className: 'panel-title' }, 'Settings'),
    el(
      'div',
      { className: 'settings-form', id: 'settings-form', onInput: clearFieldError, onChange: clearFieldError },
      sectionTitle('What workers see in the HIT list'),
      fields.Title,
      fields.Description,
      fields.Keywords,

      sectionTitle('Payment and timing'),
      el('div', { className: 'field-row field-row-5' }, fields.Reward, fields.MaxAssignments, fields.durationMinutes, fields.lifetimeDays, fields.autoApprovalDays),
      feeNotice,
      costLine,

      sectionTitle('Qualification requirements'),
      qualificationRow('approvalRateEnabled', 'HIT approval rate (%) is at least', fields.approvalRate, (on) => (approvalRate.disabled = !on)),
      qualificationRow('approvedHitsEnabled', 'Number of approved HITs is at least', fields.approvedHits, (on) => (approvedHits.disabled = !on)),
      qualificationRow('countriesEnabled', 'Worker location is one of', fields.countries, (on) => (countries.disabled = !on)),

      sectionTitle('Worker pools'),
      poolsError ? errorNotice(poolsError, 'Pools') : null,
      el('div', { className: 'field-row' }, fields.requiredPoolIds, fields.excludedPoolIds),

      sectionTitle('Attention check'),
      el('div', { className: 'switch-row' }, attentionSwitch, el('label', { for: 's-attentionEnabled' }, 'This template has attention checks')),
      attentionFields,
      attentionOff,

      sectionTitle('Review reference'),
      fields.referenceColumn,
      referenceNote,
    ),
    stepFooter({ onBack: () => ctx.goTo(1), onNext: next }),
  );
  return { node };
}

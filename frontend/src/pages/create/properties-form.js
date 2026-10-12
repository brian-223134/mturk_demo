// Project 편집기 (1) Enter Properties 의 폼. MTurk 의 같은 화면처럼 worker 에게 보이는 설명, 보상과 기간, worker 조건을 받는다.
// 값은 Project 의 properties(폼 값 그대로)로 저장되고, Publish Batch 는 이 값을 그대로 쓴다. 검수 설정(attention, 자유 서술,
// 대조 기준)은 CSV 를 올린 뒤 batch 마다 정하므로 여기에 없다 (quality-step.js).
// 입력은 바로 values 에 쓰고(set), 검사는 lib/settings.js 의 validateProperties 로 한다.

import { el } from '../../components/dom.js';
import { errorNotice, notice } from '../../components/notice.js';
import { FEE_PERCENT_10_OR_MORE, HIGH_FEE_MIN_ASSIGNMENTS, formatCents, rewardToCents } from '../../lib/cost.js';
import { MAX_AUTO_APPROVAL_DAYS, MIN_REWARD, estimateFor, normalizeCountries, normalizeReward, validateProperties } from '../../lib/settings.js';
import { field, sectionTitle } from './common.js';

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

/**
 * propertiesForm({ name, values, onName, set, pools, poolsError }) → { node, validate() }
 *  - name: Project 이름 (worker 에게 보이지 않는다). onName(text) 로 바뀐 값을 알린다
 *  - values(): 지금의 폼 값, set(patch): 일부를 바꾼다 (다시 그리지 않는다)
 *  - validate(): 오류를 각 항목에 보이고, 첫 오류 항목으로 스크롤한다. 오류가 없으면 true
 */
export function propertiesForm({ name, values, onName, set, pools, poolsError }) {
  const fields = {};
  const s = values;

  function textInput(key, attrs = {}) {
    const input = el('input', { type: 'text', id: `s-${key}`, name: key, value: s()[key] ?? '', ...attrs });
    input.addEventListener('input', () => set({ [key]: input.value }));
    return input;
  }

  /** 숫자 입력. 비어 있거나 숫자가 아니면 NaN 으로 두어 검증이 걸러 낸다. integer 면 정수로 읽는다. */
  function numberInput(key, attrs = {}, { integer = false, onChange } = {}) {
    const current = s()[key];
    const input = el('input', { type: 'number', id: `s-${key}`, name: key, value: Number.isFinite(current) ? String(current) : '', ...attrs });
    const read = () => {
      const text = input.value.trim();
      if (text === '') return Number.NaN;
      return integer ? (Number.isInteger(Number(text)) ? Number(text) : Number.NaN) : Number(text);
    };
    input.addEventListener('input', () => {
      set({ [key]: read() });
      if (onChange) onChange();
    });
    return input;
  }

  // ── Project name ──
  const nameInput = el('input', { type: 'text', id: 'project-name', value: name, maxlength: 120, placeholder: 'e.g. Passage relevance, pilot 2' });
  nameInput.addEventListener('input', () => onName(nameInput.value));
  fields.name = field({ id: 'project-name', label: 'Project name', control: nameInput, required: true, hint: 'For you only. Workers never see it.', className: 'field-wide' });

  // ── Describe your task to workers ──
  const title = textInput('Title', { maxlength: 128 });
  const description = el('textarea', { id: 's-Description', name: 'Description', rows: 2, maxlength: 2000 });
  description.value = s().Description;
  description.addEventListener('input', () => set({ Description: description.value }));
  const keywords = textInput('Keywords', { maxlength: 1000 });

  // ── Setting up your task ──
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
      feeNotice.append(notice('info', `With ${HIGH_FEE_MIN_ASSIGNMENTS} or more assignments per task, the fee becomes ${FEE_PERCENT_10_OR_MORE}% of the reward.`));
    }
    const estimate = estimateFor(v, 1);
    costLine.replaceChildren();
    if (!estimate) {
      costLine.append(el('span', { className: 'text-critical' }, 'The cost cannot be estimated: check the reward and the number of assignments.'));
      return;
    }
    costLine.append(
      el('span', { className: 'muted' }, 'Cost per task: '),
      el('span', { className: 'tabular' }, `${v.MaxAssignments} assignments × ${formatCents(rewardToCents(v.Reward))} = reward ${formatCents(estimate.rewardCents)} + fee (${estimate.feePercent}%) ${formatCents(estimate.feeCents)} = `),
      el('strong', { className: 'tabular', id: 'settings-total' }, formatCents(estimate.totalCents)),
      el('span', { className: 'muted' }, '. One CSV row is one task.'),
    );
  }

  // ── Worker requirements ──
  function qualificationRow(enabledKey, label, valueControl, syncEnabled) {
    const checkbox = el('input', { type: 'checkbox', id: `s-${enabledKey}`, name: enabledKey, checked: Boolean(s()[enabledKey]) });
    checkbox.addEventListener('change', () => {
      set({ [enabledKey]: checkbox.checked });
      syncEnabled(checkbox.checked);
    });
    syncEnabled(checkbox.checked);
    return el('div', { className: 'qual-row' }, el('label', { className: 'checkbox qual-label', for: `s-${enabledKey}` }, checkbox, ` ${label}`), valueControl);
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
  const datalist = el('datalist', { id: 'country-codes' }, COMMON_COUNTRIES.map(([code, label]) => el('option', { value: code }, `${code} – ${label}`)));
  fields.approvalRate = field({ id: 's-approvalRate', control: el('div', { className: 'suffix-input' }, approvalRate, el('span', { className: 'suffix' }, '%')), className: 'field-inline' });
  fields.approvedHits = field({ id: 's-approvedHits', control: approvedHits, className: 'field-inline' });
  fields.countries = field({ id: 's-countries', control: [countries, datalist], className: 'field-inline field-grow', hint: 'Comma or space separated ISO 3166 codes.' });

  const poolSyncs = [];
  function poolList(key, otherKey, label, hint, placeholder) {
    const list = el('div', { className: 'pool-list', id: `s-${key}` });
    const sync = () => {
      const mine = new Set(s()[key]);
      const other = new Set(s()[otherKey]);
      for (const box of list.querySelectorAll('input[type=checkbox]')) {
        box.checked = mine.has(box.value);
        box.disabled = other.has(box.value);
      }
    };
    for (const pool of pools ?? []) {
      const box = el('input', { type: 'checkbox', value: pool.id, name: key, id: `s-${key}-${pool.id}` });
      box.addEventListener('change', () => {
        const current = s()[key].filter((id) => id !== pool.id);
        set({ [key]: box.checked ? [...current, pool.id] : current });
        poolSyncs.forEach((fn) => fn());
      });
      const count = pool.workerIds?.length ?? 0;
      list.append(el('label', { className: 'checkbox pool-option', for: `s-${key}-${pool.id}` }, box, ` ${pool.name} (${count} worker${count === 1 ? '' : 's'})`));
    }
    if ((pools ?? []).length === 0) list.append(el('span', { className: 'muted' }, placeholder));
    poolSyncs.push(sync);
    return field({ id: `s-${key}`, label, control: list, hint });
  }
  fields.requiredPoolIds = poolList('requiredPoolIds', 'excludedPoolIds', 'Only workers in', 'Leave empty to allow everyone who meets the requirements above.', 'No pools yet (any worker).');
  fields.excludedPoolIds = poolList('excludedPoolIds', 'requiredPoolIds', 'Exclude workers in', null, 'No pools yet (nobody excluded).');
  poolSyncs.forEach((fn) => fn());

  fields.Title = field({ id: 's-Title', label: 'Title', control: title, required: true, hint: 'Shown to workers in the task list. Describe the task simply.' });
  fields.Description = field({ id: 's-Description', label: 'Description', control: description, required: true, hint: 'Shown to workers when they look at the task in more detail.' });
  fields.Keywords = field({ id: 's-Keywords', label: 'Keywords', control: keywords, hint: 'Comma separated words that help workers find the task.' });
  fields.Reward = field({ id: 's-Reward', label: 'Reward per assignment', control: el('div', { className: 'prefix-input' }, el('span', { className: 'prefix' }, '$'), reward), required: true });
  fields.MaxAssignments = field({ id: 's-MaxAssignments', label: 'Number of assignments per task', control: maxAssignments, hint: 'How many different workers answer each task (each CSV row).', required: true });
  fields.durationMinutes = field({ id: 's-durationMinutes', label: 'Time allotted per assignment', control: el('div', { className: 'suffix-input' }, duration, el('span', { className: 'suffix' }, 'minutes')), hint: 'How long a worker has to finish one task.', required: true });
  fields.lifetimeDays = field({ id: 's-lifetimeDays', label: 'Task expires in', control: el('div', { className: 'suffix-input' }, lifetime, el('span', { className: 'suffix' }, 'days')), hint: 'How long the tasks stay available after publishing.', required: true });
  fields.autoApprovalDays = field({ id: 's-autoApprovalDays', label: 'Auto-approve and pay workers in', control: el('div', { className: 'suffix-input' }, autoApproval, el('span', { className: 'suffix' }, 'days')), hint: `Submissions not reviewed within this time are approved. At most ${MAX_AUTO_APPROVAL_DAYS} days.`, required: true });

  refreshCost();

  // 고치기 시작하면 그 항목의 오류 문구는 지운다 (다음 검사에서 다시 본다)
  const clearFieldError = (event) => {
    const owner = event.target.closest('.field');
    if (owner && typeof owner.setError === 'function') owner.setError('');
  };

  const node = el(
    'div',
    { className: 'settings-form', id: 'properties-form', onInput: clearFieldError, onChange: clearFieldError },
    fields.name,
    sectionTitle('Describe your task to workers'),
    fields.Title,
    fields.Description,
    fields.Keywords,

    sectionTitle('Setting up your task'),
    el('div', { className: 'field-row field-row-5' }, fields.Reward, fields.MaxAssignments, fields.durationMinutes, fields.lifetimeDays, fields.autoApprovalDays),
    feeNotice,
    costLine,

    sectionTitle('Worker requirements'),
    qualificationRow('approvalRateEnabled', 'HIT approval rate (%) is at least', fields.approvalRate, (on) => (approvalRate.disabled = !on)),
    qualificationRow('approvedHitsEnabled', 'Number of approved HITs is at least', fields.approvedHits, (on) => (approvedHits.disabled = !on)),
    qualificationRow('countriesEnabled', 'Worker location is one of', fields.countries, (on) => (countries.disabled = !on)),
    poolsError ? errorNotice(poolsError, 'Pools') : null,
    el('div', { className: 'field-row' }, fields.requiredPoolIds, fields.excludedPoolIds),
  );

  function validate() {
    const errors = validateProperties(s(), { pools: pools ?? [] });
    if (nameInput.value.trim() === '') errors.name = 'Enter a project name.';
    for (const [key, node] of Object.entries(fields)) node.setError(errors[key] ?? '');
    const first = Object.keys(fields).find((key) => errors[key]);
    if (!first) return true;
    fields[first].scrollIntoView({ block: 'center', behavior: 'smooth' });
    const control = fields[first].querySelector('input, select, textarea');
    if (control && !control.disabled) control.focus({ preventScroll: true });
    return false;
  }

  return { node, validate };
}

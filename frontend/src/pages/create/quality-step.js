// Publish Batch (3) Review settings: 이 batch 의 검수 설정. attention 규칙(접두어 방식, 기대 답 컬럼 방식), 자유 서술 답의 접미어,
// Review 의 대조 기준. 기대 답 컬럼과 대조 기준 컬럼이 올린 CSV 에 달려 있어 Project 의 속성이 아니라 batch 마다 정한다.
// 처음 값은 Project 에 저장된 값(지난 batch 의 설정이나 agent 의 settings.json)이다.
// 입력은 draft.settings 에 바로 쓰고(다시 그리지 않아 커서가 유지된다), Next 를 누를 때 validateQuality 로 검사한다.

import { el } from '../../components/dom.js';
import { muted, notice } from '../../components/notice.js';
import { describeAttentionCell, describeReferenceCell, freeTextNamesOf, normalizeSuffixes, validateQuality } from '../../lib/settings.js';
import { field, sectionTitle, stepFooter } from './common.js';

const MAJORITY_LABEL = 'Majority of the other workers on the same HIT';
const ATTENTION_MODE_LABELS = { prefix: 'Answer-name prefix + one expected value', column: 'Expected answers column' };

export function renderQualityStep(ctx) {
  const { draft } = ctx;
  const columns = draft.data?.columns ?? [];
  const fields = {};
  const set = (patch) => ctx.update((current) => ({ settings: { ...current.settings, ...patch } }), { rerender: false });
  const s = () => ctx.draft.settings;

  // 미리보기가 글 입력 문항을 보고했는데 접미어가 비어 있으면 그 이름으로 채운다 (처음 들어올 때 한 번)
  const textNames = freeTextNamesOf(draft.answerSchema);
  let suggested = false;
  if (textNames.length > 0 && normalizeSuffixes(s().freeTextSuffixes).length === 0) {
    set({ freeTextSuffixes: textNames });
    suggested = true;
  }

  function textInput(key, attrs = {}) {
    const input = el('input', { type: 'text', id: `s-${key}`, name: key, value: s()[key] ?? '', ...attrs });
    input.addEventListener('input', () => set({ [key]: input.value }));
    return input;
  }

  // ── Attention check ──
  // 방식이 둘이다. prefix: 이름이 접두어로 시작하는 답이 attention 이고 기대 값은 하나. column: 행마다 CSV 셀이 { 답 이름: 기대 값 } 이라
  // attention 답이 화면에서 다른 문항과 구별되지 않는다 (agent 의 출력, 또는 attention 행을 섞은 CSV). minCorrectRatio 는 두 방식이 같이 쓴다.
  const attentionSwitch = el('input', { type: 'checkbox', id: 's-attentionEnabled', name: 'attentionEnabled', className: 'switch', role: 'switch', checked: s().attentionEnabled });
  const attentionFields = el('div', { id: 'attention-fields' });
  const attentionOff = el('p', { className: 'muted', id: 'attention-off' }, 'Without a rule, Review shows no attention result and nothing can be selected by “attention failed”.');
  const modeSelect = el('select', { id: 's-attentionMode', name: 'attentionMode' }, Object.entries(ATTENTION_MODE_LABELS).map(([value, label]) => el('option', { value }, label)));
  modeSelect.value = s().attentionMode === 'column' ? 'column' : 'prefix';
  const attentionColumnSelect = el('select', { id: 's-attentionColumn', name: 'attentionColumn' }, el('option', { value: '' }, 'Choose a CSV column'), columns.map((c) => el('option', { value: c }, c)));
  const currentAttentionColumn = s().attentionColumn;
  if (currentAttentionColumn && !columns.includes(currentAttentionColumn)) attentionColumnSelect.append(el('option', { value: currentAttentionColumn }, `${currentAttentionColumn} (not in the CSV)`));
  attentionColumnSelect.value = currentAttentionColumn ?? '';
  const attentionColumnNote = el('div', { id: 'attention-column-note' });
  const minRatio = el('input', { type: 'number', id: 's-attentionMinRatio', name: 'attentionMinRatio', min: 0, max: 1, step: 0.05, value: Number.isFinite(s().attentionMinRatio) ? String(s().attentionMinRatio) : '' });
  minRatio.addEventListener('input', () => set({ attentionMinRatio: minRatio.value.trim() === '' ? Number.NaN : Number(minRatio.value) }));

  fields.attentionMode = field({ id: 's-attentionMode', label: 'How attention answers are found', control: modeSelect, className: 'field-wide', hint: 'Use the expected answers column when the attention checks look like any other question (tasks generated from raw data do this).' });
  fields.attentionPrefix = field({ id: 's-attentionPrefix', label: 'Answer name prefix', control: textInput('attentionPrefix', { placeholder: 'attention_' }), hint: 'Answers whose name starts with this prefix are attention checks. All other answers are real questions.' });
  fields.attentionExpected = field({ id: 's-attentionExpected', label: 'Expected value', control: textInput('attentionExpected', { placeholder: 'e.g. not_relevant' }), hint: 'The answer value that counts as correct.' });
  fields.attentionColumn = field({ id: 's-attentionColumn', label: 'Expected answers column', control: attentionColumnSelect, className: 'field-grow', hint: 'Each row holds {answer name: expected value}, or is empty when the HIT has no attention check.' });
  fields.attentionMinRatio = field({ id: 's-attentionMinRatio', label: 'Minimum correct ratio', control: minRatio, hint: 'An assignment passes when correct attention answers / all attention answers is at least this value. 1 means all of them.' });
  attentionFields.append(
    fields.attentionMode,
    el('div', { className: 'field-row' }, fields.attentionPrefix, fields.attentionExpected, fields.attentionColumn, fields.attentionMinRatio),
    attentionColumnNote,
  );

  const syncAttentionColumnNote = () => {
    attentionColumnNote.replaceChildren();
    const column = s().attentionColumn;
    if (s().attentionMode !== 'column' || !column || !ctx.draft.data || !columns.includes(column)) return;
    const note = describeAttentionCell(ctx.draft.data.rows[0]?.[column] ?? '');
    attentionColumnNote.append(notice(note.type, note.message));
  };
  const syncAttention = () => {
    const { attentionEnabled, attentionMode } = s();
    attentionFields.hidden = !attentionEnabled;
    attentionOff.hidden = attentionEnabled;
    const column = attentionMode === 'column';
    fields.attentionPrefix.hidden = column;
    fields.attentionExpected.hidden = column;
    fields.attentionColumn.hidden = !column;
    syncAttentionColumnNote();
  };
  attentionSwitch.addEventListener('change', () => {
    set({ attentionEnabled: attentionSwitch.checked });
    syncAttention();
  });
  modeSelect.addEventListener('change', () => {
    set({ attentionMode: modeSelect.value });
    for (const key of ['attentionPrefix', 'attentionExpected', 'attentionColumn']) fields[key].setError('');
    syncAttention();
  });
  attentionColumnSelect.addEventListener('change', () => {
    set({ attentionColumn: attentionColumnSelect.value || null });
    syncAttentionColumnNote();
  });
  syncAttention();

  // ── Free-text answers ──
  const freeText = el('input', { type: 'text', id: 's-freeTextSuffixes', name: 'freeTextSuffixes', value: normalizeSuffixes(s().freeTextSuffixes).join(', '), placeholder: 'e.g. _missing_info, comment' });
  freeText.addEventListener('input', () => set({ freeTextSuffixes: normalizeSuffixes(freeText.value) }));
  freeText.addEventListener('change', () => {
    const suffixes = normalizeSuffixes(freeText.value);
    set({ freeTextSuffixes: suffixes });
    freeText.value = suffixes.join(', ');
  });
  fields.freeTextSuffixes = field({
    id: 's-freeTextSuffixes',
    label: 'Answer name suffixes',
    control: freeText,
    className: 'field-wide',
    hint: 'Comma separated. Answers whose name ends with one of these are free text: Review shows them as text, and they are left out of κ, majority, agreement and the reference. A whole answer name works too.',
  });
  const freeTextNote = suggested
    ? notice('info', `Filled in from the layout: ${textNames.join(', ')} ${textNames.length === 1 ? 'is a text answer' : 'are text answers'}.`)
    : textNames.length > 0
      ? muted(`Text answers in the layout: ${textNames.join(', ')}.`)
      : null;

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
  fields.referenceColumn = field({ id: 's-referenceColumn', label: 'Compare answers with', control: referenceSelect, hint: "Review shows this next to each worker's answers. Choose a CSV column that holds ground truth or LLM labels; keep the default when the CSV has no such column.", className: 'field-wide' });

  const clearFieldError = (event) => {
    const owner = event.target.closest('.field');
    if (owner && typeof owner.setError === 'function') owner.setError('');
  };

  function next() {
    const errors = validateQuality(s(), { columns });
    for (const [key, node] of Object.entries(fields)) node.setError(errors[key] ?? '');
    const first = Object.keys(errors).find((key) => fields[key]);
    if (first) {
      fields[first].scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }
    ctx.goTo(3);
  }

  const node = el(
    'section',
    { className: 'panel step', id: 'step-quality' },
    el('h3', { className: 'panel-title' }, 'Review settings'),
    muted('These settings decide how Review and Results read the answers of this batch. They start from the values saved with the project.'),
    el(
      'div',
      { className: 'settings-form', id: 'settings-form', onInput: clearFieldError, onChange: clearFieldError },
      sectionTitle('Attention check'),
      el('div', { className: 'switch-row' }, attentionSwitch, el('label', { for: 's-attentionEnabled' }, 'This batch has attention checks')),
      attentionFields,
      attentionOff,

      sectionTitle('Free-text answers'),
      fields.freeTextSuffixes,
      freeTextNote,

      sectionTitle('Review reference'),
      fields.referenceColumn,
      referenceNote,
    ),
    stepFooter({ onBack: () => ctx.goTo(1), onNext: next }),
  );
  return { node };
}

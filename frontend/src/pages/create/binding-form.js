// HIT data 화면의 binding 폼. 어떤 값이 어느 칸에 들어갈지를 드롭다운으로 고른다. JSON 편집기와 같은 binding 을 고치며, 계산은 lib/binding-form.js 에 있다.
// onChange(binding, structural): 드롭다운과 추가·삭제는 structural 이라 폼을 다시 그리고, 글을 치는 동안은 다시 그리지 않아 커서를 잃지 않는다.

import { el } from '../../components/dom.js';
import { addField, fieldsIn, pathChoices, referenceForm, removeField, setReferenceForm, updateAnswer, updateAttention, updateField, updateInstructions, updateReference, updateRepeat } from '../../lib/binding-form.js';
import { filledSlots, judgedOptions } from '../../lib/design-binding.js';
import { DATA_KINDS, SLOT_LABELS, defaultKind } from '../../lib/rough-designs.js';

const REFERENCE_FORMS = [
  ['', 'None'],
  ['value', 'One label per tab or item'],
  ['map', 'An object with numbered keys'],
  ['selected', 'A list of the positive items'],
];

function control(label, node, hint) {
  return el('label', { className: 'bf-control' }, el('span', { className: 'bf-label' }, label), node, hint ? el('span', { className: 'hint' }, hint) : null);
}

/** 지금 값이 목록에 없어도(사람이나 LLM 이 쓴 경로) 그대로 보이고 지워지지 않는다. */
function selectOf({ id, value, choices, onChange }) {
  const pairs = choices.map((choice) => (Array.isArray(choice) ? choice : [choice, choice]));
  const current = value ?? '';
  if (!pairs.some(([option]) => option === current)) pairs.unshift([current, current === '' ? 'Choose…' : current]);
  const node = el('select', { id }, pairs.map(([option, label]) => el('option', { value: option }, label)));
  node.value = current;
  node.addEventListener('change', () => onChange(node.value));
  return node;
}

function textOf({ id, value, placeholder, onInput, multiline = false }) {
  const node = multiline ? el('textarea', { id, rows: 2, placeholder }) : el('input', { type: 'text', id, placeholder });
  node.value = value ?? '';
  node.addEventListener('input', () => onInput(node.value));
  return node;
}

const smallButton = (id, label, onClick) => el('button', { type: 'button', className: 'btn btn-small btn-link', id, onClick }, label);

/** 지금 binding 의 폼. 검사가 가안과 종류를 알아낸 뒤에만 부른다. */
export function bindingForm({ get, check, reader, onChange }) {
  const { design, taskType } = check;
  const binding = get();
  const filled = filledSlots(binding, design, taskType);
  const choices = pathChoices(reader, Boolean(binding.repeat));
  const change = (op) => onChange(op(get()), true);
  const type = (op) => onChange(op(get()), false);

  function fieldRows(where) {
    const fields = fieldsIn(binding, where);
    const fallback = where === 'context' ? 'text' : defaultKind(taskType);
    const kinds = [['', `Default (${fallback})`], ...DATA_KINDS.map((kind) => [kind, kind])];
    return [
      fields.map((field, index) =>
        el(
          'div',
          { className: 'bf-row', dataset: { where, index: String(index) } },
          control('Title', textOf({ id: `bf-${where}-${index}-label`, value: field.label, placeholder: 'Title', onInput: (value) => type((b) => updateField(b, where, index, 'label', value)) })),
          control('Value', selectOf({ id: `bf-${where}-${index}-from`, value: field.from, choices: choices.values, onChange: (value) => change((b) => updateField(b, where, index, 'from', value)) })),
          control('Shown as', selectOf({ id: `bf-${where}-${index}-kind`, value: field.kind, choices: kinds, onChange: (value) => change((b) => updateField(b, where, index, 'kind', value)) })),
          fields.length > 1 || where === 'context' ? smallButton(`bf-${where}-${index}-remove`, 'Remove', () => change((b) => removeField(b, where, index))) : null,
        ),
      ),
      smallButton(`bf-${where}-add`, 'Add a value', () => change((b) => addField(b, where, choices.values))),
    ];
  }

  function optionRows(slot) {
    // 글을 치는 동안은 폼을 다시 그리지 않으므로 그릴 때의 값이 아니라 지금 값을 읽어 고친다
    const latest = () => filledSlots(get(), design, taskType)[slot].options;
    const write = (next, op = change) => op((b) => updateAnswer(b, slot, 'options', next));
    const typeAt = (index, part) => (text) => write(latest().map((pair, at) => (at === index ? (part === 0 ? [text, pair[1]] : [pair[0], text]) : pair)), type);
    const options = filled[slot].options;
    return el(
      'div',
      { className: 'bf-options' },
      el('span', { className: 'bf-label' }, 'Options (value, label)'),
      options.map(([value, label], index) =>
        el(
          'div',
          { className: 'bf-option' },
          textOf({ id: `bf-${slot}-option-${index}-value`, value, placeholder: 'value', onInput: typeAt(index, 0) }),
          textOf({ id: `bf-${slot}-option-${index}-label`, value: label, placeholder: 'label', onInput: typeAt(index, 1) }),
          options.length > 2 ? smallButton(`bf-${slot}-option-${index}-remove`, 'Remove', () => write(latest().filter((_, at) => at !== index))) : null,
        ),
      ),
      smallButton(`bf-${slot}-option-add`, 'Add an option', () => {
        const now = latest();
        write([...now, [`option_${now.length + 1}`, `Option ${now.length + 1}`]]);
      }),
    );
  }

  function answerRows(slot) {
    const spec = binding.slots?.[slot];
    const typed = (key) => (value) => type((b) => updateAnswer(b, slot, key, value));
    return [
      spec ? null : el('p', { className: 'hint', dataset: { sampled: slot } }, 'The example question is shown until you write your own.'),
      control('Question', textOf({ id: `bf-${slot}-header`, value: spec?.header, placeholder: filled[slot].header, onInput: typed('header'), multiline: true })),
      slot === 'item-choice'
        ? control(
            'Items to judge',
            selectOf({
              id: 'bf-item-choice-items',
              value: typeof filled[slot].items === 'string' ? filled[slot].items : '',
              choices: choices.lists,
              onChange: (value) => change((b) => updateAnswer(b, slot, 'items', value)),
            }),
            typeof filled[slot].items === 'string' ? null : 'Now a fixed list of example items. Choose the list from your data.',
          )
        : null,
      slot === 'free-text' ? control('Hint in the box', textOf({ id: 'bf-free-text-placeholder', value: spec?.placeholder, placeholder: filled[slot].placeholder, onInput: typed('placeholder') })) : optionRows(slot),
      control('Answer name', textOf({ id: `bf-${slot}-name`, value: spec?.name, placeholder: filled[slot].name, onInput: typed('name') }), 'The column name in the results.'),
    ];
  }

  function section(id, title, ...children) {
    return el('fieldset', { className: 'bf-section', id }, el('legend', {}, title), children);
  }

  function referenceRows(judged) {
    const form = referenceForm(binding);
    const reference = binding.reference ?? {};
    const options = judged.options.map(([value]) => value);
    return [
      control('Labels in the data', selectOf({ id: 'bf-reference-form', value: form, choices: REFERENCE_FORMS, onChange: (value) => change((b) => setReferenceForm(b, value, choices.values.at(-1))) })),
      form ? control('Labels from', selectOf({ id: 'bf-reference-path', value: reference[form], choices: choices.values, onChange: (value) => change((b) => updateReference(b, form, value)) })) : null,
      form === 'map' || form === 'selected' ? control('Key', textOf({ id: 'bf-reference-key', value: reference.key, placeholder: 'Chunk {i}', onInput: (value) => type((b) => updateReference(b, 'key', value)) }), '{i} is the tab number from 0, {n} is the item number from 1.') : null,
      form === 'selected'
        ? [
            control('Item', textOf({ id: 'bf-reference-item', value: reference.item, placeholder: 'Fact {n}', onInput: (value) => type((b) => updateReference(b, 'item', value)) })),
            control('Listed items get', selectOf({ id: 'bf-reference-yes', value: reference.yes, choices: options, onChange: (value) => change((b) => updateReference(b, 'yes', value)) })),
            control('Other items get', selectOf({ id: 'bf-reference-no', value: reference.no, choices: options, onChange: (value) => change((b) => updateReference(b, 'no', value)) })),
          ]
        : null,
    ];
  }

  function attentionRows(judged) {
    const flag = binding.attention?.flag;
    return [
      control('Marked by', selectOf({ id: 'bf-attention-flag', value: flag, choices: [['', 'None'], ...choices.values], onChange: (value) => change((b) => updateAttention(b, 'flag', value)) })),
      flag && judged
        ? control('Expected answer', selectOf({ id: 'bf-attention-expected', value: binding.attention?.expected, choices: [['', 'Do not check'], ...judged.options.map(([value, label]) => [value, label])], onChange: (value) => change((b) => updateAttention(b, 'expected', value)) }))
        : null,
    ];
  }

  const judged = judgedOptions(binding, design, taskType);
  const slots = design.rows.flatMap((row) => row.slots.flat());
  return el(
    'div',
    { className: 'binding-form', id: 'binding-form' },
    section(
      'bf-tabs',
      'Items in one HIT',
      control('One tab per item of', selectOf({ id: 'bf-repeat', value: binding.repeat?.over, choices: [['', 'None: one page per HIT'], ...choices.repeats], onChange: (value) => change((b) => updateRepeat(b, value, b.repeat?.label)) })),
      binding.repeat ? control('Tab title', textOf({ id: 'bf-repeat-label', value: binding.repeat.label, placeholder: 'Item', onInput: (value) => type((b) => updateRepeat(b, b.repeat?.over, value)) })) : null,
    ),
    slots.map((slot) => section(`bf-slot-${slot}`, SLOT_LABELS[slot], slot.startsWith('data') ? fieldRows(slot) : answerRows(slot))),
    section('bf-context', 'Values above the slots', fieldRows('context')),
    section('bf-instructions-section', 'Instructions', textOf({ id: 'bf-instructions', value: binding.instructions, placeholder: 'The example instructions are shown when this is empty.', onInput: (value) => type((b) => updateInstructions(b, value)), multiline: true })),
    judged ? section('bf-reference', 'Compare answers with', referenceRows(judged)) : null,
    section('bf-attention', 'Attention items', attentionRows(judged)),
  );
}

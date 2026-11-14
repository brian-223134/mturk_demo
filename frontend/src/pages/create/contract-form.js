// Draft with AI 화면의 과제 폼. LLM 이 쓴 계약(값, 문항, 대조 기준, attention)을 드롭다운과 글 칸으로 고친다.
// JSON 편집기와 같은 계약을 고치며, 계산은 lib/contract-form.js 에 있다.
// onChange(contract, structural): 드롭다운과 추가·삭제는 structural 이라 폼을 다시 그리고, 글을 치는 동안은 다시 그리지 않는다.

import { el } from '../../components/dom.js';
import {
  QUESTION_KINDS,
  addOption,
  addQuestion,
  addValue,
  answerValues,
  pathChoices,
  referenceOf,
  removeOption,
  removeQuestion,
  removeValue,
  setItems,
  setQuestionType,
  setReferenceValue,
  updateAttention,
  updateInstructions,
  updateLayout,
  updateOption,
  updatePerHit,
  updateQuestion,
  updateRepeat,
  updateValue,
} from '../../lib/contract-form.js';
import { control, selectOf, smallButton, textOf } from './binding-form.js';

const KINDS = [
  ['text', 'Text'],
  ['image', 'Image'],
  ['video', 'Video'],
];

/** 지금 계약의 폼. get() 은 늘 최신 계약을 돌려준다 (글을 치는 동안 폼은 다시 그리지 않는다). */
export function contractForm({ get, reader, onChange }) {
  const contract = get();
  const repeating = Boolean(contract.repeat);
  const choices = pathChoices(reader, repeating);
  const change = (op) => onChange(op(get()), true);
  const type = (op) => onChange(op(get()), false);
  const questions = Array.isArray(contract.questions) ? contract.questions : [];
  const fields = Array.isArray(contract.fields) ? contract.fields : [];

  const general = el(
    'div',
    { className: 'bf-section', id: 'cf-general' },
    control('Instructions for workers', textOf({ id: 'cf-instructions', value: contract.instructions, multiline: true, onInput: (value) => type((c) => updateInstructions(c, value)) })),
    el(
      'div',
      { className: 'bf-row' },
      control('Repeat for each element of', selectOf({ id: 'cf-repeat-over', value: contract.repeat?.over ?? '', choices: [['', 'Nothing (one item per HIT)'], ...choices.repeats], onChange: (value) => change((c) => updateRepeat(c, value, c.repeat?.label ?? 'Item')) }), 'Each element becomes its own tab or block, with its own answers.'),
      repeating ? control('Item title', textOf({ id: 'cf-repeat-label', value: contract.repeat?.label, placeholder: 'Item', onInput: (value) => type((c) => updateRepeat(c, c.repeat?.over, value)) })) : null,
      repeating ? control('Units per HIT', textOf({ id: 'cf-per-hit', value: contract.repeat?.per_hit === undefined ? '' : String(contract.repeat.per_hit), placeholder: 'All of a record', onInput: (value) => type((c) => updatePerHit(c, value)) }), 'Longer records are cut into several HITs.') : null,
    ),
    control('How the page looks', textOf({ id: 'cf-layout', value: (Array.isArray(contract.layout) ? contract.layout : []).join('\n'), placeholder: 'One wish per line, for example: Put the passage on the left and the questions on the right.', multiline: true, onInput: (value) => type((c) => updateLayout(c, value)) }), 'One wish per line. After you change them, arrange the page again. Ask in the chat to change the unit.'),
  );

  const values = el(
    'div',
    { className: 'bf-section', id: 'cf-values' },
    el('h5', { className: 'bf-heading' }, 'What workers see'),
    fields.map((field, index) =>
      el(
        'div',
        { className: 'bf-row', dataset: { value: String(index) } },
        control('Title', textOf({ id: `cf-value-${index}-label`, value: field.label, placeholder: 'Title', onInput: (value) => type((c) => updateValue(c, index, 'label', value)) })),
        control('From your data', selectOf({ id: `cf-value-${index}-from`, value: field.from, choices: choices.values, onChange: (value) => change((c) => updateValue(c, index, 'from', value)) }), repeating ? 'A path with [i] is shown for each item.' : null),
        control('Shown as', selectOf({ id: `cf-value-${index}-kind`, value: field.kind ?? 'text', choices: KINDS, onChange: (value) => change((c) => updateValue(c, index, 'kind', value === 'text' ? '' : value)) })),
        smallButton(`cf-value-${index}-remove`, 'Remove', () => change((c) => removeValue(c, index))),
      ),
    ),
    smallButton('cf-value-add', 'Add a value', () => change((c) => addValue(c, choices.values))),
  );

  function optionRows(question, index) {
    const options = (Array.isArray(question.options) ? question.options : []).map((option) => (Array.isArray(option) ? option : [option, option]));
    return el(
      'div',
      { className: 'bf-options', id: `cf-q-${index}-options` },
      options.map(([value, label], optionIndex) =>
        el(
          'div',
          { className: 'bf-row' },
          control('Value', textOf({ id: `cf-q-${index}-option-${optionIndex}-value`, value, onInput: (text) => type((c) => updateOption(c, index, optionIndex, 0, text)) }), optionIndex === 0 ? 'Saved in the results. Match your labels.' : null),
          control('Label', textOf({ id: `cf-q-${index}-option-${optionIndex}-label`, value: label, onInput: (text) => type((c) => updateOption(c, index, optionIndex, 1, text)) })),
          smallButton(`cf-q-${index}-option-${optionIndex}-remove`, 'Remove', () => change((c) => removeOption(c, index, optionIndex))),
        ),
      ),
      smallButton(`cf-q-${index}-option-add`, 'Add an option', () => change((c) => addOption(c, index))),
    );
  }

  function itemsControl(question, index) {
    const fromData = typeof question.items === 'string';
    const source = selectOf({
      id: `cf-q-${index}-items-source`,
      value: fromData ? 'data' : 'fixed',
      choices: [['data', 'A list in your data'], ['fixed', 'Fixed items']],
      onChange: (value) => change((c) => setItems(c, index, value === 'data' ? choices.lists[0] ?? '' : 'First item, Second item', value === 'data')),
    });
    const input = fromData
      ? selectOf({ id: `cf-q-${index}-items`, value: question.items, choices: choices.lists, onChange: (value) => change((c) => setItems(c, index, value, true)) })
      : textOf({ id: `cf-q-${index}-items`, value: (question.items ?? []).map((item) => (typeof item === 'object' ? item.text : item)).join(', '), placeholder: 'Comma-separated', onInput: (value) => type((c) => setItems(c, index, value, false)) });
    return el('div', { className: 'bf-row' }, control('Items', source), control(fromData ? 'List' : 'Items, separated by commas', input));
  }

  function referenceControl(question, index) {
    if (question.type === 'text') return null;
    const { ref, form } = referenceOf(contract, question.name);
    if (form && form !== 'value') return el('p', { className: 'muted small', id: `cf-q-${index}-reference` }, `Compared with ${ref[form]} (${form} form). Edit it as JSON.`);
    return control('Compare answers with', selectOf({ id: `cf-q-${index}-reference`, value: ref?.value ?? '', choices: [['', 'Nothing'], ...choices.values, ...choices.lists.filter((path) => !choices.values.includes(path))], onChange: (value) => change((c) => setReferenceValue(c, question.name, value)) }), 'A column with the right answer for each HIT or item. It is never shown to workers.');
  }

  const questionCards = questions.map((question, index) =>
    el(
      'div',
      { className: 'bf-question', dataset: { question: question.name } },
      el('div', { className: 'bf-row' }, control('Question', textOf({ id: `cf-q-${index}-header`, value: question.header, onInput: (value) => type((c) => updateQuestion(c, index, 'header', value)) })), control('Answer', selectOf({ id: `cf-q-${index}-type`, value: question.type, choices: QUESTION_KINDS, onChange: (value) => change((c) => setQuestionType(c, index, value, choices.lists)) }))),
      ['choice', 'item-choice'].includes(question.type) ? optionRows(question, index) : null,
      ['checklist', 'item-choice'].includes(question.type) ? itemsControl(question, index) : null,
      question.type === 'likert'
        ? el(
            'div',
            { className: 'bf-row' },
            control('From', textOf({ id: `cf-q-${index}-min`, value: String(question.min ?? 1), onInput: (value) => type((c) => updateQuestion(c, index, 'min', Number.parseInt(value, 10))) })),
            control('To', textOf({ id: `cf-q-${index}-max`, value: String(question.max ?? 5), onInput: (value) => type((c) => updateQuestion(c, index, 'max', Number.parseInt(value, 10))) })),
            control('Low end', textOf({ id: `cf-q-${index}-min-label`, value: question.min_label, onInput: (value) => type((c) => updateQuestion(c, index, 'min_label', value)) })),
            control('High end', textOf({ id: `cf-q-${index}-max-label`, value: question.max_label, onInput: (value) => type((c) => updateQuestion(c, index, 'max_label', value)) })),
          )
        : null,
      question.type === 'text' ? control('Hint in the box', textOf({ id: `cf-q-${index}-placeholder`, value: question.placeholder, onInput: (value) => type((c) => updateQuestion(c, index, 'placeholder', value)) })) : null,
      el(
        'div',
        { className: 'bf-row bf-checks' },
        el('label', { className: 'check-label' }, (() => {
          const box = el('input', { type: 'checkbox', id: `cf-q-${index}-required` });
          box.checked = question.type === 'text' ? question.required === true : question.required !== false;
          box.addEventListener('change', () => change((c) => updateQuestion(c, index, 'required', box.checked === (question.type !== 'text') ? '' : box.checked)));
          return box;
        })(), ' Required'),
        repeating
          ? el('label', { className: 'check-label' }, (() => {
              const box = el('input', { type: 'checkbox', id: `cf-q-${index}-per-item` });
              box.checked = question.per_item !== false;
              box.addEventListener('change', () => change((c) => updateQuestion(c, index, 'per_item', box.checked ? '' : false)));
              return box;
            })(), ' Ask for each item')
          : null,
        el('span', { className: 'muted small' }, `Answer name: ${question.name}`),
        smallButton(`cf-q-${index}-remove`, 'Remove question', () => change((c) => removeQuestion(c, index))),
      ),
      referenceControl(question, index),
    ),
  );

  const newKind = selectOf({ id: 'cf-question-kind', value: 'choice', choices: QUESTION_KINDS, onChange: () => {} });
  const questionSection = el(
    'div',
    { className: 'bf-section', id: 'cf-questions' },
    el('h5', { className: 'bf-heading' }, 'What workers answer'),
    questionCards,
    el('div', { className: 'bf-row' }, control('New question', newKind), smallButton('cf-question-add', 'Add a question', () => change((c) => addQuestion(c, newKind.value, choices.lists)))),
  );

  const judged = questions.filter((q) => q.type !== 'text');
  const attentionQuestion = questions.find((q) => q.name === contract.attention?.question);
  const attention = el(
    'div',
    { className: 'bf-section', id: 'cf-attention' },
    el('h5', { className: 'bf-heading' }, 'Attention checks'),
    el(
      'div',
      { className: 'bf-row' },
      control('Marked by', selectOf({ id: 'cf-attention-flag', value: contract.attention?.flag ?? '', choices: [['', 'No attention checks'], ...choices.values], onChange: (value) => change((c) => updateAttention(updateAttention(c, 'flag', value), 'question', c.attention?.question ?? judged[0]?.name)) }), 'A column that is 1 for attention items.'),
      contract.attention
        ? [
            control('Question', selectOf({ id: 'cf-attention-question', value: contract.attention.question ?? '', choices: judged.map((q) => [q.name, q.header]), onChange: (value) => change((c) => updateAttention(c, 'question', value)) })),
            control('Expected answer', selectOf({ id: 'cf-attention-expected', value: contract.attention.expected ?? '', choices: [['', 'Not checked'], ...answerValues(attentionQuestion)], onChange: (value) => change((c) => updateAttention(c, 'expected', value)) })),
          ]
        : null,
    ),
  );

  return el('div', { className: 'binding-form contract-form', id: 'contract-form' }, general, values, questionSection, attention);
}

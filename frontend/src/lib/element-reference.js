// Design Layout 의 "Insert" 메뉴와 "Element reference" 패널이 쓰는 <ann-*> 요소 설명. 동작은 elements/ann-elements.js 에 있고,
// 사람이 읽는 설명서는 docs/annotation-elements.md 다. 속성을 바꾸면 세 곳을 함께 고친다.
// snippet 은 Design Layout 의 커서 자리에 넣을 글이다. 템플릿처럼 `${컬럼}` 을 그대로 쓴다.

export const ELEMENT_REFERENCE = [
  {
    tag: 'ann-form',
    summary: 'The form around every question. Adds the progress line and the Submit button, checks required answers and sends them.',
    attributes: [['submit-label', 'Text of the Submit button (default "Submit").']],
    snippet: '<ann-form>\n  \n</ann-form>',
  },
  {
    tag: 'ann-instructions',
    summary: 'Instructions panel that workers can fold. Write any HTML inside.',
    attributes: [
      ['header', 'Panel title (default "Instructions").'],
      ['collapsed', 'Start folded.'],
    ],
    snippet: '<ann-instructions>\n  <p>Explain the task here.</p>\n</ann-instructions>',
  },
  {
    tag: 'ann-text',
    summary: 'A card that shows a value from the CSV. Line breaks in the value are kept.',
    attributes: [['label', 'Small title above the text.']],
    snippet: '<ann-text label="Passage">${passage}</ann-text>',
  },
  {
    tag: 'ann-choice',
    summary: 'One answer from a list (radio buttons). Answer name = name, value = the chosen option value.',
    attributes: [
      ['name', 'Answer name. Required and unique.'],
      ['header', 'The question.'],
      ['required', 'Workers must answer before submitting.'],
      ['options', 'Short form "a, b, c" when value and label are the same. Otherwise use <ann-option value="…">Label</ann-option> children.'],
      ['layout', '"horizontal" puts the options on one line.'],
    ],
    snippet: '<ann-choice name="question_1" header="Write the question" required>\n  <ann-option value="yes">Yes</ann-option>\n  <ann-option value="no">No</ann-option>\n</ann-choice>',
  },
  {
    tag: 'ann-likert',
    summary: 'A score from min to max. Values are the numbers as text ("1" … "5").',
    attributes: [
      ['name', 'Answer name. Required and unique.'],
      ['header', 'The question.'],
      ['required', 'Workers must answer before submitting.'],
      ['min / max', 'Range of the scale (default 1 to 5).'],
      ['min-label / max-label', 'Words at both ends of the scale.'],
    ],
    snippet: '<ann-likert name="score" header="Rate the text" required min="1" max="5" min-label="Poor" max-label="Excellent"></ann-likert>',
  },
  {
    tag: 'ann-checklist',
    summary:
      'Check every item that applies, plus a "none" box. One answer per item, named name_key, with checked-value or unchecked-value. Items come from <ann-item> children or a JSON array column.',
    attributes: [
      ['name', 'Answer name prefix. Required and unique.'],
      ['header', 'The question.'],
      ['required', 'At least one box (or the none box) must be checked.'],
      ['checked-value / unchecked-value', 'Values sent for each item (default "yes" / "no").'],
      ['none-label', 'Text of the none box (default "None of the above"). no-none hides it.'],
      ['numbered', 'Show the item number before each item.'],
    ],
    snippet:
      '<ann-checklist name="supported" header="Which statements does the passage support?" required\n               checked-value="supported" unchecked-value="not_supported">\n  <script type="application/json">${facts}</script>\n</ann-checklist>',
  },
  {
    tag: 'ann-textarea',
    summary: 'Free text. The trimmed text is sent; an empty optional answer is left out. Review shows it as text and keeps it out of κ and agreement.',
    attributes: [
      ['name', 'Answer name. Required and unique.'],
      ['header', 'The question.'],
      ['required', 'Workers must write something.'],
      ['minlength', 'Minimum number of characters.'],
      ['rows / placeholder', 'Size and hint of the text box.'],
    ],
    snippet: '<ann-textarea name="comment" header="Comment (optional)" rows="2"></ann-textarea>',
  },
  {
    tag: 'ann-tabs',
    summary: 'Split several items of one HIT into tabs. Each tab title shows how many required answers are left in it.',
    attributes: [['ann-tab header', 'Title of each tab (default "Item n").']],
    snippet:
      '<ann-tabs>\n  <ann-tab header="Item 1">\n    <ann-text>${item_1}</ann-text>\n  </ann-tab>\n  <ann-tab header="Item 2">\n    <ann-text>${item_2}</ann-text>\n  </ann-tab>\n</ann-tabs>',
  },
];

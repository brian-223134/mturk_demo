// New Project 의 rough design: Requester 가 먼저 고르는 화면 배치 가안과, Vision / Video / Text 별 예시 내용.
// ROUGH_DESIGNS 는 도형 배치만 적은 JSON 모양의 정의다. 고르는 화면의 도형 그림(pages/create/rough-design.js)과 미리보기 템플릿이
// 모두 이 정의에서 나오고, 나중에 LLM 에 넘길 명세서도 이 정의를 쓴다.
//   rows[].slots   왼쪽부터 놓을 칸 (SLOT_LABELS 의 키). 칸이 둘 이상이면 columns 비율로 나눈다
//   rows[].weight  도형 그림에서 이 줄의 높이 비율
//   tabs           있으면 rows 전체를 탭 수만큼 되풀이한다
// 표본 글과 그림은 모두 직접 만든 합성 자료다. Video 의 표본은 영상 파일 없이 Vision 의 그림을 쓴다 (ann-video 가 정지 화면으로 그린다).
// tests/rough-designs.test.js 가 가안과 task 종류의 모든 조합이 바로 쓸 수 있는 상태인지 본다.

import { settingsFromProperties } from './settings.js';

export const SLOT_LABELS = {
  data: 'Data',
  'data-a': 'Data 1',
  'data-b': 'Data 2',
  choice: 'HIT: multiple choice',
  compare: 'HIT: choose one',
  checklist: 'HIT: check each item',
  'free-text': 'Short answer',
};

export const ROUGH_DESIGNS = [
  {
    id: 'side-by-side',
    letter: 'A',
    title: 'Side by side',
    summary: 'Data on the left, the HIT on the right, and a wide box for a short answer below. The data stays in view while workers answer.',
    rows: [
      { columns: '3fr 2fr', weight: 3, slots: ['data', 'choice'] },
      { weight: 1, slots: ['free-text'] },
    ],
  },
  {
    id: 'stacked',
    letter: 'B',
    title: 'Stacked',
    summary: 'Data across the full width, with multiple choice and a short answer below. Good for long passages and wide images.',
    rows: [
      { weight: 3, slots: ['data'] },
      { columns: '1fr 1fr', weight: 2, slots: ['choice', 'free-text'] },
    ],
  },
  {
    id: 'compare',
    letter: 'C',
    title: 'Comparison',
    summary: 'Two pieces of data next to each other, and one question below that picks between them.',
    rows: [
      { columns: '1fr 1fr', weight: 3, slots: ['data-a', 'data-b'] },
      { weight: 1, slots: ['compare'] },
    ],
  },
  {
    id: 'tabs',
    letter: 'D',
    title: 'Tabs',
    summary: 'Several items in one HIT, one tab per item. Each tab shows how many answers are left.',
    tabs: 3,
    rows: [
      { weight: 3, slots: ['data'] },
      { weight: 2, slots: ['choice'] },
    ],
  },
  {
    id: 'item-list',
    letter: 'E',
    title: 'Item by item',
    summary: 'One piece of data on the left and a list of items on the right. Workers check every item that applies.',
    rows: [{ columns: '3fr 2fr', weight: 1, slots: ['data', 'checklist'] }],
  },
];

export const TASK_TYPES = [
  { id: 'vision', title: 'Vision', summary: 'Workers look at an image and annotate it.' },
  { id: 'video', title: 'Video', summary: 'Workers watch a clip and annotate it.' },
  { id: 'text', title: 'Text', summary: 'Workers read a text and annotate it.' },
];

const SAMPLE_IMAGES = ['/elements/samples/street.svg', '/elements/samples/park.svg', '/elements/samples/harbor.svg'];
const SETTINGS_OPTIONS = [
  ['city_street', 'City street'],
  ['park', 'Park'],
  ['harbor', 'Harbor'],
];

const CONTENT = {
  vision: {
    tag: 'ann-image',
    column: 'image_url',
    label: 'Image',
    samples: SAMPLE_IMAGES,
    instructions: 'Look at the image, then answer the questions about it.',
    choice: { name: 'setting', header: 'What does the image show?', options: SETTINGS_OPTIONS },
    compare: { name: 'preference', header: 'Which image shows the busier scene?', instructions: 'Look at both images, then choose one.' },
    checklist: { name: 'visible', header: 'Which of these can you see in the image?', items: ['A car', 'A tree', 'A boat', 'A bicycle'] },
    freeText: { name: 'notes', header: 'Short answer (optional)', placeholder: 'Explain your answer in a sentence' },
    properties: {
      Title: 'Answer questions about an image',
      Description: 'Look at an image and answer a few short questions about it.',
      Keywords: 'image, vision, labeling',
      Reward: '0.05',
      MaxAssignments: 3,
      durationMinutes: 10,
    },
  },
  video: {
    tag: 'ann-video',
    column: 'video_url',
    label: 'Video',
    samples: SAMPLE_IMAGES,
    instructions: 'Watch the clip, then answer the questions about it.',
    choice: { name: 'setting', header: 'Where does the clip take place?', options: SETTINGS_OPTIONS },
    compare: { name: 'preference', header: 'Which clip shows the busier scene?', instructions: 'Watch both clips, then choose one.' },
    checklist: { name: 'visible', header: 'Which of these appear in the clip?', items: ['A car', 'A tree', 'A boat', 'A bicycle'] },
    freeText: { name: 'notes', header: 'Short answer (optional)', placeholder: 'Explain your answer in a sentence' },
    properties: {
      Title: 'Answer questions about a short video',
      Description: 'Watch a short video clip and answer a few short questions about it.',
      Keywords: 'video, clip, labeling',
      Reward: '0.10',
      MaxAssignments: 3,
      durationMinutes: 15,
    },
  },
  text: {
    tag: 'ann-text',
    column: 'text',
    label: 'Passage',
    samples: [
      'The city library opened in 1921 in a converted school building. After a fire damaged the school in 1968, the collection moved to a new building on Elm Street, where it remains today.',
      'Most mornings the bakery on the corner sells out of rye bread before nine. Regulars now phone ahead, and the owner keeps a short list of names taped next to the till.',
      'The coastal train takes about four hours and stops at six fishing towns. Sit on the left side of the carriage for the best view of the bay in the afternoon.',
    ],
    instructions: 'Read the passage, then answer the questions about it.',
    choice: {
      name: 'topic',
      header: 'What is the passage mainly about?',
      options: [
        ['history', 'History'],
        ['daily_life', 'Daily life'],
        ['travel', 'Travel'],
      ],
    },
    compare: { name: 'preference', header: 'Which passage gives more specific details?', instructions: 'Read both passages, then choose one.' },
    checklist: { name: 'supported', header: 'Which statements does the passage support?', items: ['The library opened in 1921.', 'A fire damaged the school.', 'The library has three floors.'] },
    freeText: { name: 'notes', header: 'Short answer (optional)', placeholder: 'Explain your answer in a sentence' },
    properties: {
      Title: 'Answer questions about a short passage',
      Description: 'Read a short passage and answer a few short questions about it.',
      Keywords: 'text, reading, labeling',
      Reward: '0.05',
      MaxAssignments: 3,
      durationMinutes: 10,
    },
  },
};

export function roughDesignById(id) {
  return ROUGH_DESIGNS.find((design) => design.id === id) ?? null;
}

export function taskTypeById(id) {
  return TASK_TYPES.find((type) => type.id === id) ?? null;
}

/** 가안과 task 종류의 주소. taskTypeId 가 없으면 아직 종류를 고르지 않은 화면이다. */
export function designPath(designId, taskTypeId) {
  const base = `/create/new/design/${encodeURIComponent(designId)}`;
  return taskTypeId ? `${base}/${encodeURIComponent(taskTypeId)}` : base;
}

function indented(lines, depth = 1) {
  return lines.map((line) => `${'  '.repeat(depth)}${line}`);
}

/** 칸 하나를 템플릿 줄들로 바꾼다. suffix 는 탭 번호처럼 컬럼과 답 이름에 붙일 글이고, sampleIndex 는 쓸 표본의 번호다. */
function slotLines(slot, content, suffix, sampleIndex, sampleRow) {
  const dataLines = (columnSuffix, label, index) => {
    const column = `${content.column}${columnSuffix}`;
    sampleRow[column] = content.samples[index];
    return content.tag === 'ann-text' ? [`<ann-text label="${label}">\${${column}}</ann-text>`] : [`<${content.tag} label="${label}" src="\${${column}}"></${content.tag}>`];
  };
  const optionLines = (options) => options.map(([value, label]) => `  <ann-option value="${value}">${label}</ann-option>`);
  switch (slot) {
    case 'data':
      return dataLines(suffix, content.label, sampleIndex);
    case 'data-a':
      return dataLines('_a', `${content.label} 1`, 0);
    case 'data-b':
      return dataLines('_b', `${content.label} 2`, 1);
    case 'choice':
      return [`<ann-choice name="${content.choice.name}${suffix}" header="${content.choice.header}" required>`, ...optionLines(content.choice.options), '</ann-choice>'];
    case 'compare':
      return [
        `<ann-choice name="${content.compare.name}" header="${content.compare.header}" required layout="horizontal">`,
        ...optionLines([
          ['first', `${content.label} 1`],
          ['second', `${content.label} 2`],
          ['same', 'About the same'],
        ]),
        '</ann-choice>',
      ];
    case 'checklist':
      sampleRow.items = JSON.stringify(content.checklist.items);
      return [`<ann-checklist name="${content.checklist.name}" header="${content.checklist.header}" required>`, '  <script type="application/json">${items}</script>', '</ann-checklist>'];
    case 'free-text':
      return [`<ann-textarea name="${content.freeText.name}${suffix}" header="${content.freeText.header}" rows="2" placeholder="${content.freeText.placeholder}"></ann-textarea>`];
    default:
      throw new Error(`Unknown slot: ${slot}`);
  }
}

function rowLines(row, content, suffix, sampleIndex, sampleRow) {
  const cells = row.slots.map((slot) => slotLines(slot, content, suffix, sampleIndex, sampleRow));
  if (cells.length === 1) return cells[0];
  return [`<ann-columns columns="${row.columns}">`, ...cells.flatMap((cell) => indented(['<ann-column>', ...indented(cell), '</ann-column>'])), '</ann-columns>'];
}

/**
 * 고른 가안과 task 종류로 새 Project 의 내용을 만든다 → { name, html, sampleRow, properties }.
 * html 은 <ann-*> 요소로 쓴 템플릿이고, sampleRow 는 그 컬럼을 모두 채우는 표본 행이다.
 */
export function buildDesignTemplate(design, taskType) {
  const content = CONTENT[taskType.id];
  const sampleRow = {};
  const body = design.tabs
    ? [
        '<ann-tabs>',
        ...Array.from({ length: design.tabs }, (_, index) =>
          indented([`<ann-tab header="${content.label} ${index + 1}">`, ...indented(design.rows.flatMap((row) => rowLines(row, content, `_${index + 1}`, index, sampleRow))), '</ann-tab>']),
        ).flat(),
        '</ann-tabs>',
      ]
    : design.rows.flatMap((row) => rowLines(row, content, '', 0, sampleRow));
  const usesCompare = design.rows.some((row) => row.slots.includes('compare'));
  const instructions = usesCompare ? content.compare.instructions : design.tabs ? `${content.instructions} Do this in every tab.` : content.instructions;
  const html = [
    '<script src="/elements/ann-elements.js"></script>',
    '',
    '<ann-form>',
    '  <ann-instructions>',
    `    <p>${instructions}</p>`,
    '  </ann-instructions>',
    '',
    ...indented(body),
    '</ann-form>',
    '',
  ].join('\n');
  return { name: `${design.title} (${taskType.title})`, html, sampleRow, properties: settingsFromProperties(content.properties) };
}

/** 이름과 layout 이 똑같은 Project. Publish Batch 에서 뒤로 왔다가 다시 넘어가도 같은 Project 를 또 만들지 않게 한다. */
export function findSameProject(templates, name, html) {
  return templates.find((template) => template.name === name.trim() && template.html === html) ?? null;
}

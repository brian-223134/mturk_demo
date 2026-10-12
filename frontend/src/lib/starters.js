// New Project 의 starter 템플릿 목록 (MTurk 의 "Select a customizable template"). 템플릿 파일은 elements/starters/*.html 이고
// <ann-*> 요소(elements/ann-elements.js)로 쓴 짧은 HTML 이다. 여기에는 갤러리에 보일 설명, Design Layout 미리보기의 표본 행,
// 새 Project 의 Enter Properties 에 미리 채울 값만 둔다. 표본 글은 모두 직접 쓴 합성 문장이다.
// tests/starters.test.js 가 파일마다 표본 행이 placeholder 를 다 채우는지, layout 검사에 오류가 없는지 본다.

export const STARTER_CATEGORIES = [
  { key: 'retrieval', label: 'Retrieval & grounding' },
  { key: 'text', label: 'Text' },
  { key: 'other', label: 'Other' },
];

const LIBRARY_PASSAGE =
  'The city library opened in 1921 in a converted school building. After a fire damaged the school in 1968, the collection moved to a new building on Elm Street, where it remains today.';

export const STARTERS = [
  {
    id: 'passage-relevance',
    category: 'retrieval',
    title: 'Passage relevance',
    summary: 'Show a query and one retrieved passage. Workers choose relevant, partially relevant or not relevant.',
    file: 'passage-relevance.html',
    sampleRow: {
      query: 'When did the city library move to Elm Street?',
      passage: LIBRARY_PASSAGE,
    },
    properties: {
      Title: 'Judge whether a passage answers a question',
      Description: 'Read a short question and a passage, then say whether the passage helps answer the question.',
      Keywords: 'relevance, reading, passage, question',
      Reward: '0.05',
      MaxAssignments: 3,
      durationMinutes: 10,
    },
  },
  {
    id: 'fact-support',
    category: 'retrieval',
    title: 'Statement support (checklist)',
    summary: 'Show a passage and a list of statements from a JSON column. Workers check every statement the passage supports.',
    file: 'fact-support.html',
    sampleRow: {
      passage: LIBRARY_PASSAGE,
      facts: JSON.stringify(['The library opened in 1921.', 'A fire damaged the original building.', 'The library has three floors.']),
    },
    properties: {
      Title: 'Check which statements a passage supports',
      Description: 'Read a passage and tick every statement that the passage supports.',
      Keywords: 'fact checking, reading, passage, statements',
      Reward: '0.08',
      MaxAssignments: 3,
      durationMinutes: 15,
    },
  },
  {
    id: 'passages-in-tabs',
    category: 'retrieval',
    title: 'Several passages per HIT (tabs)',
    summary: 'One query with three passages, one tab per passage. Each tab shows how many answers are left.',
    file: 'passages-in-tabs.html',
    sampleRow: {
      query: 'When did the city library move to Elm Street?',
      passage_1: LIBRARY_PASSAGE,
      passage_2: 'Elm Street was paved in 1950 and is lined with oak trees. A bakery and two cafes sit at its north end.',
      passage_3: 'In 1969 the library reopened on Elm Street with twice as many shelves as the old school building had.',
    },
    properties: {
      Title: 'Judge three search results for one question',
      Description: 'Read a question and three passages, then say for each passage whether it helps answer the question.',
      Keywords: 'relevance, search, reading, passages',
      Reward: '0.12',
      MaxAssignments: 3,
      durationMinutes: 20,
    },
  },
  {
    id: 'text-classification',
    category: 'text',
    title: 'Text classification',
    summary: 'Show one text and ask for one category, like the sentiment of a review.',
    file: 'text-classification.html',
    sampleRow: {
      text: 'The blender is powerful and easy to clean, but it is much louder than the one I had before.',
    },
    properties: {
      Title: 'Choose the sentiment of a product review',
      Description: 'Read a short product review and choose whether it is positive, negative, mixed or neutral.',
      Keywords: 'sentiment, classification, review, text',
      Reward: '0.03',
      MaxAssignments: 3,
      durationMinutes: 5,
    },
  },
  {
    id: 'multi-label',
    category: 'text',
    title: 'Multi-label tagging',
    summary: 'Show one text and a fixed list of tags. Workers check every tag that applies.',
    file: 'multi-label.html',
    sampleRow: {
      text: 'My order arrived two weeks late and the box was crushed. I asked for a refund but nobody has replied yet.',
    },
    properties: {
      Title: 'Tag the topics of a customer message',
      Description: 'Read a short customer message and check every topic it talks about.',
      Keywords: 'tagging, topics, classification, text',
      Reward: '0.04',
      MaxAssignments: 3,
      durationMinutes: 5,
    },
  },
  {
    id: 'answer-rating',
    category: 'text',
    title: 'Answer rating (scale)',
    summary: 'Show a question and an answer. Workers rate helpfulness from 1 to 5 and may leave a comment.',
    file: 'answer-rating.html',
    sampleRow: {
      question: 'How long should I boil an egg for a soft yolk?',
      answer: 'Boil the egg for about six minutes, then move it to cold water so it stops cooking.',
    },
    properties: {
      Title: 'Rate how helpful an answer is',
      Description: 'Read a question and an answer, then rate the answer on a scale from 1 to 5.',
      Keywords: 'rating, answers, quality, text',
      Reward: '0.05',
      MaxAssignments: 3,
      durationMinutes: 10,
    },
  },
  {
    id: 'pairwise',
    category: 'text',
    title: 'Pairwise comparison',
    summary: 'Show two responses side by side. Workers pick the better one and explain why.',
    file: 'pairwise.html',
    sampleRow: {
      prompt: 'Suggest a name for a small bakery that sells sourdough bread.',
      response_a: 'Rise and Crust',
      response_b: 'Bakery Number Seven, which is a friendly and welcoming place to buy bread and cakes.',
    },
    properties: {
      Title: 'Pick the better of two responses',
      Description: 'Compare two responses to the same request, choose the better one and explain your choice.',
      Keywords: 'comparison, preference, responses, writing',
      Reward: '0.08',
      MaxAssignments: 3,
      durationMinutes: 10,
    },
  },
  {
    id: 'free-text',
    category: 'text',
    title: 'Free-text writing',
    summary: 'Show a passage and collect a short written answer, such as a one-sentence summary.',
    file: 'free-text.html',
    sampleRow: { passage: LIBRARY_PASSAGE },
    properties: {
      Title: 'Summarize a short passage in one sentence',
      Description: 'Read a short passage and write a one-sentence summary in your own words.',
      Keywords: 'writing, summary, reading, passage',
      Reward: '0.10',
      MaxAssignments: 2,
      durationMinutes: 10,
    },
  },
  {
    id: 'blank',
    category: 'other',
    title: 'Blank layout',
    summary: 'A minimal form with one text and one question, to build your own layout from.',
    file: 'blank.html',
    sampleRow: { text: 'The text that workers read goes here.' },
    properties: {},
  },
];

export function starterById(id) {
  return STARTERS.find((starter) => starter.id === id) ?? null;
}

/** 템플릿 파일의 주소 (nginx 가 frontend/src 를 / 로 서빙한다). */
export function starterUrl(starter) {
  return `/elements/starters/${starter.file}`;
}

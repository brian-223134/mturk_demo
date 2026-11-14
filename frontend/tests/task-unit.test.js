// Draft with AI 의 앞단: 모양이 다른 JSON 에서 기록 찾기(lib/json-records.js), Agent 가 정한 단위대로 기록을 HIT 로 바꾸기(lib/task-unit.js),
// 영상 frame 과 페이지 바람(lib/task-contract.js). example/7-draft-with-ai 의 합성 데이터 세 가지로 따라간다.
// 마지막 묶음은 흐름 시험이다: 가짜 Agent 답 → 검사·재요청 → HIT 표 → 기본 페이지와 게시용 행 → harness.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { dataReader, summarizeData } from '../src/lib/design-binding.js';
import { checkAgentHtml } from '../src/lib/html-harness.js';
import { DataFileError } from '../src/lib/json-data.js';
import { findRecords, parseRecordsJson } from '../src/lib/json-records.js';
import { contractOutline, harnessContract, layoutText, requestContract, timeSeconds } from '../src/lib/task-contract.js';
import { checkDesign, planData, splitColumn, splitParagraphs, splitSentences, unitChoices, unitOptions, unitSummary } from '../src/lib/task-unit.js';

const file = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const example = (name) => parseRecordsJson(file(`example/7-draft-with-ai/${name}`), name);
const summaries = example('summaries-nested.json');
const sentences = example('sentences.jsonl');
const clips = example('clips-by-id.json');

// Agent 가 쓸 만한 계약 (손으로 씀)
const sentenceContract = {
  unit: { level: 'sentence', why: 'Each summary sentence can be right or wrong on its own.', split: { from: 'summary', by: 'sentence' } },
  instructions: 'Read the source, then decide whether each summary sentence is supported by it.',
  repeat: { over: 'summary_sentences', label: 'Sentence', per_hit: 3 },
  fields: [
    { id: 'source', label: 'Source', from: 'source' },
    { id: 'sentence', label: 'Summary sentence', from: 'summary_sentences[i]' },
  ],
  questions: [{ name: 'supported', type: 'choice', header: 'Is this sentence supported by the source?', options: [['yes', 'Supported'], ['no', 'Not supported']], layout: 'horizontal' }],
  layout: ['Show the source on the left and the sentence with the question on the right.'],
};
const groupedContract = {
  unit: { level: 'sentence', why: 'label has one label per sentence.', group_by: 'doc_id' },
  instructions: 'Decide whether each sentence states a fact or an opinion.',
  repeat: { over: 'sentence', label: 'Sentence' },
  fields: [
    { id: 'title', label: 'Article', from: 'doc_title' },
    { id: 'sentence', label: 'Sentence', from: 'sentence[i]' },
  ],
  questions: [{ name: 'kind', type: 'choice', header: 'Does this sentence state a fact or an opinion?', options: [['fact', 'Fact'], ['opinion', 'Opinion']] }],
  reference: [{ question: 'kind', value: 'label[i]' }],
  layout: [],
};
const frameContract = {
  unit: { level: 'frame', why: 'frame_times lists the moments to judge.' },
  instructions: 'Look at the clip at each moment and say whether a person is visible.',
  repeat: { over: 'frame_times', label: 'Frame' },
  fields: [
    { id: 'place', label: 'Place', from: 'place' },
    { id: 'clip', label: 'Clip', from: 'video', kind: 'video', at: 'frame_times[i]' },
  ],
  questions: [{ name: 'person', type: 'choice', header: 'Is a person visible at this moment?', options: [['yes', 'Yes'], ['no', 'No']] }],
  layout: [],
};

describe('parseRecordsJson: 모양에 상관없이 기록 찾기', () => {
  it('감싼 객체 안의 가장 긴 객체 목록을 기록으로 읽고, 길 위의 단순 값은 기록마다 복사한다', () => {
    assert.equal(summaries.rows.length, 4);
    assert.deepEqual(summaries.source, { kind: 'nested', path: 'items', records: 4 });
    assert.deepEqual(summaries.columns, ['dataset', 'version', 'id', 'source', 'summary']);
    assert.equal(summaries.rows[2].dataset, 'summary-faithfulness-demo');
    assert.ok(summaries.warnings.some((w) => w.includes('from "items"')));
  });

  it('JSON Lines 는 줄마다 기록 하나다', () => {
    assert.equal(sentences.rows.length, 12);
    assert.equal(sentences.source.kind, 'lines');
    assert.equal(sentences.rows[0].sent_no, '1', '값은 문자열이 된다');
  });

  it('id 로 묶인 객체는 키를 "key" 컬럼으로 둔다. 목록 값은 JSON 글이 된다', () => {
    assert.deepEqual(clips.columns, ['key', 'video', 'place', 'frame_times']);
    assert.equal(clips.rows[1].key, 'clip-02');
    assert.deepEqual(JSON.parse(clips.rows[1].frame_times), ['0:02', '0:05.5', '0:09']);
  });

  it('값 목록, 기록 하나, 깊이 들어간 목록, 이름에 빈칸이 있는 키', () => {
    assert.deepEqual(findRecords(['a', 'b']).records, [{ value: 'a' }, { value: 'b' }]);
    assert.equal(findRecords({ title: 'T', text: 'x' }).kind, 'single');
    assert.deepEqual(findRecords({ c1: { video: 'a.mp4' } }).records, [{ key: 'c1', video: 'a.mp4' }], 'id 로 묶인 객체가 하나여도 푼다');
    assert.equal(findRecords({ meta: { lang: 'en' }, body: { text: 'x' } }).kind, 'single', '키가 서로 다른 객체 둘은 기록 하나다');
    const deep = findRecords({ meta: { name: 'n' }, data: { batch: { rows: [{ a: 1 }, { a: 2 }] }, other: [{ b: 1 }] } });
    assert.equal(deep.path, 'data.batch.rows');
    assert.deepEqual(deep.records[0], { a: 1 }, '목록 옆이 아닌 객체의 값(meta.name)은 복사하지 않는다');
    const spaced = parseRecordsJson('[{"Claim text": "c", "a.b": 1}]', 'x.json');
    assert.deepEqual(spaced.columns, ['Claim_text', 'a_b']);
    assert.ok(spaced.warnings.some((w) => w.startsWith('Renamed')));
  });

  it('읽을 수 없는 것은 이유를 알린다', () => {
    for (const text of ['not json', '[]', '"just text"', '{}']) assert.throws(() => parseRecordsJson(text, 'x.json'), DataFileError, text);
  });
});

describe('글 나누기와 시각', () => {
  it('문장과 문단으로 나눈다. 줄바꿈도 문장의 끝이다', () => {
    assert.deepEqual(splitSentences('One. Two!  Three?\nTitle line'), ['One.', 'Two!', 'Three?', 'Title line']);
    assert.deepEqual(splitParagraphs('A1. A2.\n\nB1.\n\n\nC1.'), ['A1. A2.', 'B1.', 'C1.']);
    assert.deepEqual(splitParagraphs('Line one\nLine two'), ['Line one', 'Line two'], '빈 줄이 없으면 줄바꿈으로');
    assert.equal(splitColumn('meta.body', 'paragraph'), 'meta_body_paragraphs');
  });

  it('시각은 초나 m:ss 로 읽는다', () => {
    assert.equal(timeSeconds(7.25), 7.25);
    assert.equal(timeSeconds('0:05.5'), 5.5);
    assert.equal(timeSeconds('1:00:02'), 3602);
    assert.equal(timeSeconds('soon'), null);
  });
});

describe('unitOptions: Agent 에게 보낼 단위 후보', () => {
  it('긴 글은 문장·문단 수와 새 컬럼 이름을, 되풀이되는 id 는 묶었을 때의 모양을 알린다', () => {
    const options = unitOptions(dataReader(summaries));
    const summary = options.split.find((option) => option.from === 'summary');
    assert.deepEqual(summary.sentence, { per_record: { min: 3, max: 5 }, makes: 'summary_sentences' });
    const groupOptions = unitOptions(dataReader(sentences)).group_by;
    assert.ok(!groupOptions.some((option) => option.column === 'doc_title'), 'doc_id 와 같은 묶음을 만드는 컬럼은 한 번만');
    const grouped = groupOptions.find((option) => option.column === 'doc_id');
    assert.equal(grouped.groups, 3);
    assert.deepEqual(grouped.records_per_group, { min: 3, max: 5 });
    assert.ok(grouped.stays_single.includes('doc_title') && grouped.becomes_list.includes('sentence') && grouped.becomes_list.includes('label'));
    assert.ok(!unitOptions(dataReader(sentences)).split.some((option) => option.from === 'label'), '정답처럼 보이는 컬럼은 나누지 않는다');
  });

  it('영상 주소와 시각 목록은 frame 후보다. 영상이 없으면 숫자 목록을 시각으로 보지 않는다', () => {
    const options = unitOptions(dataReader(clips));
    assert.deepEqual(options.media.video, ['video']);
    assert.deepEqual(options.frames, [{ column: 'frame_times', holds: 'times' }]);
    assert.deepEqual(unitChoices(options, frameContract), ['video'], '영상 데이터는 영상 단위만, 지금 단위(frame)는 뺀다');
    assert.deepEqual(unitChoices(unitOptions(dataReader(summaries)), sentenceContract), ['document', 'chunk']);
    const numbers = unitOptions(dataReader(parseRecordsJson('[{"scores": [1, 2]}, {"scores": [3]}]', 'x.json')));
    assert.deepEqual(numbers.frames, []);
  });

  it('요약에는 객체 컬럼의 키가 따로 나온다', () => {
    const data = parseRecordsJson('[{"meta": {"title": "a", "body": "b", "x": 1, "y": 2, "z": 3}}]', 'x.json');
    const [column] = summarizeData(dataReader(data)).columns;
    assert.deepEqual(column.keys.map((key) => key.name), ['title', 'body', 'x', 'y', 'z']);
  });
});

describe('planData: 단위대로 HIT 표 만들기', () => {
  it('글을 문장으로 나누고, per_hit 보다 많으면 HIT 를 자르며 몇 번째 부분인지 남긴다', () => {
    const plan = planData(summaries, sentenceContract);
    assert.deepEqual(plan.errors, []);
    // 문장 수 4, 3, 5, 3 → 3개씩: 2 + 1 + 2 + 1
    assert.equal(plan.data.rows.length, 6);
    assert.deepEqual(plan.data.rows.map((row) => [row.id, row.unit_part, row.unit_start]), [['s1', '1', '1'], ['s1', '2', '4'], ['s2', '1', '1'], ['s3', '1', '1'], ['s3', '2', '4'], ['s4', '1', '1']]);
    assert.deepEqual(JSON.parse(plan.data.rows[1].summary_sentences), ['The regional government will pay the full cost.']);
    assert.equal(plan.data.rows[1].source, summaries.rows[0].source, '단위 목록이 아닌 값은 부분마다 그대로');
    assert.ok(plan.warnings.some((w) => w.includes('cut into several HITs')));
  });

  it('같은 doc_id 의 기록을 HIT 하나로 묶는다. 모든 묶음에서 같은 값은 하나로, 나머지는 목록이 된다', () => {
    const plan = planData(sentences, groupedContract);
    assert.equal(plan.data.rows.length, 3);
    const [first] = plan.data.rows;
    assert.equal(first.doc_title, 'New park opens');
    assert.deepEqual(JSON.parse(first.label), ['fact', 'opinion', 'fact', 'opinion']);
    assert.deepEqual(JSON.parse(first.sent_no), ['1', '2', '3', '4'], '셀은 문자열로 읽으므로 목록의 값도 문자열이다');
  });

  it('잘못된 계획은 Agent 에게 보낼 오류가 된다', () => {
    const errorsOf = (contract, data = summaries) => planData(data, contract).errors;
    assert.ok(errorsOf({ ...sentenceContract, unit: { level: 'word' } })[0].startsWith('unit.level'));
    assert.ok(errorsOf({ ...sentenceContract, unit: { level: 'sentence', split: { from: 'body', by: 'sentence' } } })[0].includes('no column "body"'));
    assert.ok(errorsOf({ ...sentenceContract, unit: { level: 'sentence', split: { from: 'summary', by: 'word' } } })[0].startsWith('unit.split.by'));
    assert.ok(errorsOf({ ...groupedContract, unit: { level: 'sentence', group_by: 'nothing' } }, sentences)[0].includes('no column'));
    assert.ok(errorsOf({ ...sentenceContract, repeat: { ...sentenceContract.repeat, per_hit: 0 } })[0].startsWith('repeat.per_hit'));
    const mapped = { ...groupedContract, repeat: { over: 'sentence', per_hit: 2 }, reference: [{ question: 'kind', map: 'label', key: 'x_{i}' }] };
    assert.ok(errorsOf(mapped, sentences)[0].includes('"map" or "selected"'));
  });

  it('unit 이 없는 예전 계약은 표를 그대로 둔다', () => {
    const plan = planData(summaries, { instructions: 'x' });
    assert.equal(plan.data.rows, summaries.rows);
  });
});

describe('checkDesign: 단위 + 계약 검사', () => {
  it('세 예시의 계약이 모두 통과하고 탭 수를 센다', () => {
    assert.deepEqual(checkDesign(sentenceContract, summaries).errors, []);
    assert.equal(checkDesign(sentenceContract, summaries).tabs, 3);
    assert.deepEqual(checkDesign(groupedContract, sentences).errors, []);
    assert.equal(checkDesign(groupedContract, sentences).tabs, 5);
    assert.deepEqual(checkDesign(frameContract, clips).errors, []);
  });

  it('Agent 의 답에는 unit 이 있어야 하고, 단위와 맞지 않는 값은 막는다', () => {
    const { unit, ...noUnit } = sentenceContract;
    assert.ok(unit);
    assert.ok(checkDesign(noUnit, summaries, { requireUnit: true }).errors[0].includes('"unit" is missing'));
    assert.deepEqual(checkDesign({ ...noUnit, repeat: undefined, fields: [{ id: 's', label: 'S', from: 'summary' }] }, summaries).errors, [], '손으로 붙인 계약은 없어도 된다');
    assert.ok(checkDesign({ ...frameContract, fields: [{ id: 'place', label: 'Place', from: 'place' }] }, clips).errors.some((e) => e.includes('needs a value shown as a video')));
  });

  it('frame 시각은 영상 값에만, 읽을 수 있는 시각이어야 한다', () => {
    const bad = (field) => checkDesign({ ...frameContract, fields: [frameContract.fields[0], { ...frameContract.fields[1], ...field }] }, clips).errors;
    assert.ok(bad({ kind: 'image' }).some((e) => e.includes('only for a video')));
    assert.ok(bad({ at: 'place' }).some((e) => e.includes('is not a time')));
  });

  it('layout 은 짧은 문장 목록이어야 한다', () => {
    assert.ok(checkDesign({ ...sentenceContract, layout: 'left' }, summaries).errors.some((e) => e.startsWith('"layout"')));
    assert.equal(layoutText(sentenceContract), '- Show the source on the left and the sentence with the question on the right.');
    assert.equal(layoutText(groupedContract), '');
  });

  it('요약: 단위, 이유, 만드는 방법, 기록 수 → HIT 수', () => {
    const check = checkDesign(sentenceContract, summaries);
    const summary = unitSummary(sentenceContract, summaries, check.data);
    assert.equal(summary.level, 'sentence');
    assert.equal(summary.records, 4);
    assert.equal(summary.hits, 6);
    assert.deepEqual(summary.how, ['summary is split into sentences', 'one sentence per element of summary_sentences', 'at most 3 per HIT']);
    assert.deepEqual(contractOutline(sentenceContract).layout, sentenceContract.layout);
  });
});

describe('attention 의 기대 답과 정답', () => {
  const passage = parseRecordsJson(file('scripts/html_experiment/data/passage-answer.json'), 'p.json');
  const contract = {
    unit: { level: 'document', why: 'One label per passage.' },
    instructions: 'Read the passage and say whether it answers the question.',
    fields: [{ id: 'question', label: 'Question', from: 'question' }, { id: 'body', label: 'Passage', from: 'body' }],
    questions: [{ name: 'answer', type: 'choice', header: 'Does the passage answer the question?', options: [['yes', 'Yes'], ['partly', 'Partly'], ['no', 'No']] }],
    reference: [{ question: 'answer', value: 'gold' }],
    attention: { flag: 'attention', question: 'answer', expected: 'yes' },
  };

  it('정답이 attention 항목에 주는 라벨과 다른 기대 답은 막는다 (유료 시험에서 Agent 가 표본에 없는 attention 항목을 짐작한 일)', () => {
    const { errors } = checkDesign(contract, passage);
    assert.ok(errors.some((e) => e.includes('"yes" disagrees with the answer key') && e.includes('Use "no"') && e.includes('HIT 5')), errors.join(' | '));
    assert.deepEqual(checkDesign({ ...contract, attention: { ...contract.attention, expected: 'no' } }, passage).errors, []);
  });
});

describe('흐름: Agent 답 → HIT → 페이지', () => {
  it('unit 이 빠진 첫 답은 오류와 함께 다시 묻고, 고친 답으로 HIT 와 페이지를 만든다', async () => {
    const { unit, ...noUnit } = sentenceContract;
    const replies = [{ contract: noUnit, message: 'first' }, { contract: sentenceContract, message: 'fixed', usage: { calls: 1, cost: 0.001 } }];
    const sent = [];
    const result = await requestContract({
      send: async (body) => {
        sent.push(body);
        return replies.shift();
      },
      check: (contract) => checkDesign(contract, summaries, { requireUnit: true }),
      request: { goal: 'Is each summary sentence supported?', data: summarizeData(dataReader(summaries)), units: unitOptions(dataReader(summaries)) },
    });
    assert.ok(unit);
    assert.equal(result.attempts, 2);
    assert.ok(sent[1].errors[0].includes('"unit" is missing'));
    assert.equal(sent[0].units.split[0].from, 'source');

    const check = checkDesign(result.contract, summaries);
    const harness = harnessContract(result.contract, check.reader);
    assert.equal(harness.data.rows.length, 6);
    assert.equal(harness.data.rows[1].f_sentence_1, 'The regional government will pay the full cost.');
    assert.equal(harness.data.rows[1].f_sentence_2, '', '자른 마지막 부분의 남는 탭은 비어 있다 (요소가 숨긴다)');
    assert.deepEqual(checkAgentHtml(harness.html, harness).errors, [], '기본 페이지는 harness 를 통과한다');
  });

  it('탭마다 present 컬럼으로 이 HIT 에 그 항목이 있는지 알린다. Agent 페이지가 그것을 다른 탭에 두거나 빼면 막는다', () => {
    const check = checkDesign(sentenceContract, summaries);
    const harness = harnessContract(sentenceContract, check.reader);
    assert.match(harness.html, /<ann-tab header="Sentence 2" present="\$\{t_2\}">/);
    assert.deepEqual([1, 2, 3].map((n) => harness.data.rows[1][`t_${n}`]), ['1', '', ''], '잘린 부분에 문장이 하나뿐');
    assert.equal(harness.roles.t_2, 'attribute');
    // 값을 ann-text 대신 일반 요소에 넣어도 된다 (빈 탭은 present 로 숨긴다)
    const spans = harness.html.replace(/<ann-text label="Summary sentence">(\$\{f_sentence_\d\})<\/ann-text>/g, '<p><strong>$1</strong></p>');
    assert.deepEqual(checkAgentHtml(spans, harness).errors, []);
    const swapped = harness.html.replace('present="${t_1}"', 'present="${t_x}"').replace('present="${t_2}"', 'present="${t_1}"').replace('present="${t_x}"', 'present="${t_2}"');
    assert.ok(checkAgentHtml(swapped, harness).errors.some((e) => e.includes('of another item')));
    const dropped = harness.html.replace(' present="${t_3}"', '');
    assert.ok(checkAgentHtml(dropped, harness).errors.some((e) => e.includes('"t_3" is missing')));
    const grouped = harnessContract(groupedContract, checkDesign(groupedContract, sentences).reader).data.rows;
    assert.deepEqual(grouped.map((row) => row.t_5), ['', '', '1'], '다섯째 문장은 세 번째 기사에만 있다');
  });

  it('묶은 문장의 라벨이 대조 기준이 되고, frame 은 주소 뒤에 #t= 시각이 붙는다', () => {
    const grouped = checkDesign(groupedContract, sentences);
    const harness = harnessContract(groupedContract, grouped.reader);
    assert.deepEqual(JSON.parse(harness.data.rows[1].slot_reference), { kind_1: 'fact', kind_2: 'opinion', kind_3: 'fact' });
    assert.ok(harness.answerColumns.includes('label'));

    const framed = checkDesign(frameContract, clips);
    const rows = harnessContract(frameContract, framed.reader).data.rows;
    assert.equal(rows[0].f_clip_3, '/media/example/crossing-01.mp4#t=7.25');
    assert.equal(rows[1].f_clip_2, '/media/example/crossing-02.mp4#t=5.5');
    assert.equal(contractOutline(frameContract).values[1].kind, 'frame');
  });
});

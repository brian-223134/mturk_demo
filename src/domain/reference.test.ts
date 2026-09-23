import { describe, expect, it } from 'vitest';
import {
  agreementWithReference,
  majorityReference,
  mapReferenceToAnswers,
  normalizeLabel,
  parseReferenceCell,
} from './reference';

const PREFIX = 'attention_';

describe('normalizeLabel', () => {
  it('대소문자와 앞뒤 공백을 무시한다', () => {
    expect(normalizeLabel('  Not Covered ')).toBe('not covered');
    expect(normalizeLabel('Not covered')).toBe(normalizeLabel('Not Covered'));
  });
});

describe('parseReferenceCell', () => {
  it('JSON 객체, 배열, 스칼라', () => {
    expect(parseReferenceCell('{"general_0_1": "Covered", "n": 2}')).toEqual({ general_0_1: 'Covered', n: 2 });
    expect(parseReferenceCell('["grounded", "not_grounded"]')).toEqual(['grounded', 'not_grounded']);
    expect(parseReferenceCell('3')).toBe(3);
    expect(parseReferenceCell(' true ')).toBe(true);
  });

  it('Python repr 객체 (fixture의 LLM 라벨 형식)', () => {
    expect(parseReferenceCell("{'general_0_1': 'Covered', 'general_1_1': 'Not covered'}")).toEqual({
      general_0_1: 'Covered',
      general_1_1: 'Not covered',
    });
    expect(parseReferenceCell("[{'Core subquery1': 'Covered'}, {'Core subquery1': 'Not covered'}]")).toEqual([
      { 'Core subquery1': 'Covered' },
      { 'Core subquery1': 'Not covered' },
    ]);
  });

  it('Python의 True/False/None과 이스케이프', () => {
    expect(parseReferenceCell("{'a': True, 'b': False, 'c': None, 'd': 'None'}")).toEqual({ a: true, b: false, c: null, d: 'None' });
    expect(parseReferenceCell("{'a': 'it\\'s', 'b': 'line\\nbreak', 'c': '\\xe9'}")).toEqual({ a: "it's", b: 'line\nbreak', c: 'é' });
  });

  it('값 안의 작은따옴표로 깨지거나 큰따옴표가 든 셀은 Python으로 읽지 않고 평문으로 남긴다', () => {
    expect(parseReferenceCell("{'a': 'don't'}")).toBe("{'a': 'don't'}");
    expect(parseReferenceCell('{\'a\': "don\'t"}')).toBe('{\'a\': "don\'t"}');
    expect(parseReferenceCell("{'a': 'unterminated}")).toBe("{'a': 'unterminated}");
  });

  it('JSON도 Python 리터럴도 아니면 셀 전체가 값 하나. 빈 셀은 undefined', () => {
    expect(parseReferenceCell('')).toBeUndefined();
    expect(parseReferenceCell('   ')).toBeUndefined();
    expect(parseReferenceCell('Covered')).toBe('Covered');
    expect(parseReferenceCell(' not_grounded ')).toBe('not_grounded');
    expect(parseReferenceCell('Synthetic statement: Lorem ipsum.')).toBe('Synthetic statement: Lorem ipsum.');
  });
});

describe('mapReferenceToAnswers', () => {
  const answers = [
    { name: 'general_0_1_coverage' },
    { name: 'general_1_1_coverage' },
    { name: 'attention_2_1_coverage' },
  ];

  it('객체: 정확히 같은 키, 없으면 접두어가 같은 키 중 가장 긴 것', () => {
    const parsed = { general_0_1: 'Covered', general_1_1: 'Not covered', general_1_1_coverage: 'Exact', general: 'x' };
    expect(mapReferenceToAnswers(parsed, answers, PREFIX)).toEqual({
      general_0_1_coverage: 'Covered',
      general_1_1_coverage: 'Exact',
    });
    // 더 긴 접두어가 이긴다. `general_1`은 `general_10_1`의 접두어가 아니다 (뒤에 `_`가 와야 한다)
    expect(mapReferenceToAnswers({ general_1: 'short', general_1_1: 'long' }, [{ name: 'general_1_1_x' }, { name: 'general_10_1' }], PREFIX)).toEqual({
      general_1_1_x: 'long',
    });
  });

  it('객체: 값이 string|number|boolean이 아니면 무시한다', () => {
    const parsed = { general_0_1: ['Covered'], general_1_1: 1, attention_2_1: true };
    expect(mapReferenceToAnswers(parsed, answers, PREFIX)).toEqual({ general_1_1_coverage: '1', attention_2_1_coverage: 'true' });
  });

  it('배열: 길이가 전체 답 수와 같으면 모든 답에, attention을 뺀 수와 같으면 일반 문항에만', () => {
    expect(mapReferenceToAnswers(['a', 'b', 'c'], answers, PREFIX)).toEqual({
      general_0_1_coverage: 'a',
      general_1_1_coverage: 'b',
      attention_2_1_coverage: 'c',
    });
    expect(mapReferenceToAnswers(['a', 'b'], answers, PREFIX)).toEqual({
      general_0_1_coverage: 'a',
      general_1_1_coverage: 'b',
    });
    expect(mapReferenceToAnswers(['a'], answers, PREFIX)).toEqual({});
    expect(mapReferenceToAnswers(['a', { nested: 1 }], answers, PREFIX)).toEqual({ general_0_1_coverage: 'a' });
  });

  it('스칼라: attention을 뺀 답이 정확히 하나일 때만', () => {
    expect(mapReferenceToAnswers('grounded', [{ name: 'general_1' }, { name: 'attention_1' }], PREFIX)).toEqual({ general_1: 'grounded' });
    expect(mapReferenceToAnswers(1, [{ name: 'general_1' }], PREFIX)).toEqual({ general_1: '1' });
    expect(mapReferenceToAnswers('grounded', answers, PREFIX)).toEqual({});
    expect(mapReferenceToAnswers(undefined, [{ name: 'general_1' }], PREFIX)).toEqual({});
    expect(mapReferenceToAnswers(null, [{ name: 'general_1' }], PREFIX)).toEqual({});
  });
});

describe('majorityReference', () => {
  it('문항별 majority. 동률이거나 표가 없으면 키가 없다', () => {
    const others = [
      [{ name: 'q1', value: 'a' }, { name: 'q2', value: 'a' }, { name: 'q3', value: 'a' }],
      [{ name: 'q1', value: 'a' }, { name: 'q2', value: 'b' }],
      [{ name: 'q1', value: 'b' }, { name: 'q2', value: 'b' }],
    ];
    expect(majorityReference(others)).toEqual({ q1: 'a', q2: 'b', q3: 'a' });
    expect(majorityReference([[{ name: 'q1', value: 'a' }], [{ name: 'q1', value: 'b' }]])).toEqual({});
    expect(majorityReference([])).toEqual({});
  });
});

describe('agreementWithReference', () => {
  it('attention을 빼고 reference가 있는 문항만 비교한다. 비교는 대소문자와 공백을 무시한다', () => {
    const answers = [
      { name: 'general_0_1_coverage', value: 'Not Covered' },
      { name: 'general_1_1_coverage', value: 'Covered' },
      { name: 'general_2_1_coverage', value: 'Covered' },
      { name: 'attention_3_1_coverage', value: 'Covered' },
    ];
    const reference = {
      general_0_1_coverage: 'Not covered',
      general_1_1_coverage: 'Not covered',
      attention_3_1_coverage: 'Not Covered',
    };
    expect(agreementWithReference(answers, reference, PREFIX)).toBe(0.5); // 0_1 일치, 1_1 불일치, 2_1 기준 없음, attention 제외
  });

  it('비교할 문항이 없으면 null', () => {
    expect(agreementWithReference([{ name: 'general_1', value: 'a' }], {}, PREFIX)).toBeNull();
    expect(agreementWithReference([{ name: 'attention_1', value: 'a' }], { attention_1: 'a' }, PREFIX)).toBeNull();
    expect(agreementWithReference([], { general_1: 'a' }, PREFIX)).toBeNull();
  });
});

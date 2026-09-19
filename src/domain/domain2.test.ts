// M1~M2에서 추가한 domain 함수: Fleiss κ, 결과 요약, 재모집 계획, 템플릿 렌더, CSV 검증, export 형식

import { describe, expect, it } from 'vitest';
import { agreementWithOthers, collectItems, fleissKappa, summarizeResults } from './agreement';
import { checkData, rowSizeBytes } from './dataCheck';
import { buildLabelsJson, toCsv, toMturkTime } from './exportFormats';
import { planTopUp } from './progress';
import { PREVIEW_MESSAGE_SOURCE, jsonForScript, renderTemplate } from './template';

describe('fleissKappa (8.4)', () => {
  it('Fleiss(1971)의 예제: 문항 10개, 평가자 14명, 범주 5개 → κ = 0.210', () => {
    const counts = [
      [0, 0, 0, 0, 14], [0, 2, 6, 4, 2], [0, 0, 3, 5, 6], [0, 3, 9, 2, 0], [2, 2, 8, 1, 1],
      [7, 7, 0, 0, 0], [3, 2, 6, 3, 0], [2, 5, 3, 2, 2], [6, 5, 2, 1, 0], [0, 2, 2, 3, 7],
    ];
    const items = counts.map((row) => row.flatMap((n, category) => Array<string>(n).fill(`c${category}`)));
    expect(fleissKappa(items)).toBeCloseTo(0.21, 3);
  });

  it('완전 일치는 1, 정의되지 않는 경우는 null', () => {
    expect(fleissKappa([['a', 'a', 'a'], ['b', 'b', 'b']])).toBe(1);
    expect(fleissKappa([])).toBeNull();
    expect(fleissKappa([['a'], ['b']])).toBeNull(); // 평가자가 1명
    expect(fleissKappa([['a', 'a', 'a'], ['a', 'a', 'a']])).toBeNull(); // 모든 표가 한 범주라 P̄e = 1
  });

  it('문항마다 투표 수가 다르면 오류', () => {
    expect(() => fleissKappa([['a', 'b'], ['a', 'b', 'a']])).toThrow(RangeError);
  });
});

describe('collectItems, summarizeResults', () => {
  const vote = (rowIndex: number, answerName: string, value: string, workerId: string) => ({ rowIndex, answerName, value, workerId });
  const items = collectItems([
    vote(1, 'general_10_1', 'a', 'W1'), vote(0, 'general_2_1', 'a', 'W1'), vote(0, 'general_2_1', 'a', 'W2'), vote(0, 'general_2_1', 'a', 'W3'),
    vote(0, 'general_10_1', 'a', 'W1'), vote(0, 'general_10_1', 'b', 'W2'), vote(1, 'general_10_1', 'b', 'W2'),
  ]);

  it('문항별로 묶고 행, 문항 이름(숫자 순)으로 정렬한다', () => {
    expect(items.map((i) => i.key)).toEqual(['0:general_2_1', '0:general_10_1', '1:general_10_1']);
    expect(items[0]).toMatchObject({ votes: ['a', 'a', 'a'], workers: ['W1', 'W2', 'W3'], majority: 'a', unanimous: true });
    expect(items[1]).toMatchObject({ majority: null, unanimous: false });
  });

  it('κ와 만장일치 비율은 투표 수가 target인 문항만, 라벨 분포는 전체 표로 센다', () => {
    const summary = summarizeResults(items, 3);
    expect(summary).toMatchObject({ kappaItemCount: 1, unanimousRatio: 1, labelDistribution: { a: 5, b: 2 } });
    expect(summarizeResults([], 3)).toMatchObject({ kappaItemCount: 0, unanimousRatio: null, fleissKappa: null });
  });

  it('라벨 JSON의 모양', () => {
    expect(JSON.parse(buildLabelsJson(items))['0:general_2_1']).toEqual({ votes: ['a', 'a', 'a'], majority: 'a', workers: ['W1', 'W2', 'W3'] });
  });
});

describe('agreementWithOthers', () => {
  const answers = (values: Record<string, string>) => Object.entries(values).map(([name, value]) => ({ name, value }));
  it('다른 worker들의 majority와 같은 비율. 동률이거나 표가 없는 문항은 제외한다', () => {
    const own = answers({ q1: 'a', q2: 'a', q3: 'a', q4: 'a' });
    const others = [answers({ q1: 'a', q2: 'b', q3: 'a' }), answers({ q1: 'a', q2: 'b', q3: 'b' })];
    expect(agreementWithOthers(own, others)).toBe(0.5); // q1 일치, q2 불일치, q3 동률, q4 표 없음
    expect(agreementWithOthers(own, [])).toBeNull();
  });
});

describe('planTopUp (8.3)', () => {
  const hit = (MaxAssignments: number, initialMaxAssignments = 3) => ({ MaxAssignments, initialMaxAssignments });

  it("'fill-to-target'은 부족분만큼, 숫자는 그만큼 추가한다", () => {
    expect(planTopUp(hit(3), { shortfall: 2 }, 'fill-to-target')).toEqual({ add: 2 });
    expect(planTopUp(hit(3), { shortfall: 0 }, 2)).toEqual({ add: 2 });
    expect(planTopUp(hit(3), { shortfall: 0 }, 'fill-to-target').add).toBe(0);
  });

  it('10 미만으로 만든 HIT는 합계 9까지만. 넘으면 일부만 넣지 않고 건너뛴다', () => {
    expect(planTopUp(hit(6), { shortfall: 3 }, 'fill-to-target')).toEqual({ add: 3 });
    const over = planTopUp(hit(8), { shortfall: 2 }, 'fill-to-target');
    expect(over.add).toBe(0);
    expect(over.reason).toMatch(/cannot exceed 9/);
  });

  it('처음부터 10 이상으로 만든 HIT에는 상한이 없다', () => {
    expect(planTopUp(hit(12, 12), { shortfall: 0 }, 5)).toEqual({ add: 5 });
  });

  it('음수나 소수는 오류', () => {
    expect(() => planTopUp(hit(3), { shortfall: 0 }, -1)).toThrow(RangeError);
    expect(() => planTopUp(hit(3), { shortfall: 0 }, 1.5)).toThrow(RangeError);
  });
});

describe('renderTemplate (5.5)', () => {
  it('${컬럼명}은 escape 없이 그대로 치환하고, 행에 없는 이름은 그대로 둔다', () => {
    const html = '<script>var q = ${query}; var x = ${missing};</script>';
    expect(renderTemplate(html, { query: "['a', 'b']" })).toContain("var q = ['a', 'b']; var x = ${missing};");
  });

  it('셀에 $&, $1 같은 치환 패턴이 있어도 글자 그대로 들어간다', () => {
    expect(renderTemplate('<p>${text}</p>', { text: 'cost $& and $1' })).toContain('<p>cost $& and $1</p>');
  });

  it('TASK_DATA는 <head> 맨 앞에 넣고, <head>가 없는 조각이면 문서 맨 앞에 넣는다', () => {
    const withHead = renderTemplate('<html><head><title>t</title></head><body></body></html>', { a: '1' });
    expect(withHead).toMatch(/<head><script>window\.TASK_DATA = \{"a":"1"\};<\/script><title>/);
    expect(renderTemplate('<crowd-form></crowd-form>', { a: '1' })).toMatch(/^<script>window\.TASK_DATA = /);
  });

  it('데이터에 </script>가 있어도 문서가 깨지지 않는다', () => {
    const rendered = renderTemplate('<html><head></head><body></body></html>', { text: '</script><script>alert(1)</script>' });
    expect(rendered.match(/<\/script>/g)).toHaveLength(1);
    expect(JSON.parse(jsonForScript({ t: '</script>' }))).toEqual({ t: '</script>' });
  });

  it('미리보기용 스크립트는 preview일 때만 들어간다', () => {
    expect(renderTemplate('<p></p>', {})).not.toContain(PREVIEW_MESSAGE_SOURCE);
    expect(renderTemplate('<p></p>', {}, { preview: true })).toContain(PREVIEW_MESSAGE_SOURCE);
  });
});

describe('checkData (5.2의 Data 단계)', () => {
  const rows = [{ query: 'q1', chunk: 'c1', extra: 'x' }, { query: 'q2', chunk: '', extra: 'y' }];

  it('템플릿에만 있는 컬럼은 오류, CSV에만 있는 컬럼은 안내, 빈 셀이 있는 행 번호', () => {
    const check = checkData(['query', 'chunk', 'facts'], ['query', 'chunk', 'extra'], rows);
    expect(check).toMatchObject({
      rowCount: 2,
      columnCount: 3,
      matchedPlaceholders: ['query', 'chunk'],
      missingColumns: ['facts'],
      unusedColumns: ['extra'],
      rowsWithEmptyCells: [1],
    });
  });

  it('행 크기는 UTF-8 바이트로 센다. 64KB를 넘는 행을 센다 (11장)', () => {
    expect(rowSizeBytes({ a: '한글', b: 'ab' })).toBe(8);
    const big = checkData([], ['text'], [{ text: 'x'.repeat(70_000) }, { text: 'small' }]);
    expect(big).toMatchObject({ rowSizeMaxBytes: 70_000, rowsOverQuestionLimit: 1 });
    expect(big.rowSizeMedianBytes).toBe((70_000 + 5) / 2);
  });
});

describe('export 형식', () => {
  it('toCsv: 쉼표, 따옴표, 줄바꿈이 있는 셀만 따옴표로 감싼다', () => {
    expect(toCsv(['a', 'b'], [['plain', 'x,y'], ['say "hi"', 'line1\nline2']])).toBe('a,b\r\nplain,"x,y"\r\n"say ""hi""","line1\nline2"\r\n');
  });

  it('toMturkTime: MTurk 결과 CSV의 시각 표기 (UTC)', () => {
    expect(toMturkTime('2025-10-09T07:30:20Z')).toBe('Thu Oct 09 07:30:20 UTC 2025');
    expect(toMturkTime(undefined)).toBe('');
  });
});

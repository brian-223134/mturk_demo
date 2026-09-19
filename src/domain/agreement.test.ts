import { describe, expect, it } from 'vitest';
import { itemKey, majority, majorityOfTally, tally } from './agreement';

describe('itemKey', () => {
  it('<rowIndex>:<answerName> 형식', () => {
    expect(itemKey(12, 'general_0_1')).toBe('12:general_0_1');
  });
});

describe('majority', () => {
  it('최다 득표 값', () => {
    expect(majority(['grounded', 'grounded', 'not_grounded'])).toBe('grounded');
    expect(majority(['Yes'])).toBe('Yes');
  });

  it('동률이면 null', () => {
    expect(majority(['grounded', 'not_grounded'])).toBeNull();
    expect(majority(['a', 'a', 'b', 'b', 'c'])).toBeNull();
  });

  it('뒤에 나온 값이 동률을 깨면 그 값이 majority', () => {
    expect(majority(['a', 'b', 'a', 'b', 'c', 'c', 'c'])).toBe('c');
  });

  it('표가 없으면 null', () => {
    expect(majority([])).toBeNull();
  });
});

describe('majorityOfTally', () => {
  it('0 이하인 득표는 없는 것으로 본다 (자기 표를 뺀 집계에서 생긴다)', () => {
    expect(majorityOfTally(new Map([['a', 0], ['b', 1]]))).toBe('b');
    expect(majorityOfTally(new Map([['a', 0]]))).toBeNull();
  });
});

describe('tally', () => {
  it('값별 득표 수', () => {
    expect(tally(['a', 'b', 'a'])).toEqual(new Map([['a', 2], ['b', 1]]));
  });
});

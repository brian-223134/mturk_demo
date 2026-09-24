// 값을 화면 글자로 바꾸는 도우미 검사. 시각은 로컬 시간대로 찍히므로 TZ 를 UTC 로 고정한 뒤 모듈을 불러온다
// (import 문은 끌어올려지므로 동적 import 를 쓴다).

process.env.TZ = 'UTC';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const {
  EMPTY,
  formatBytes,
  formatCents,
  formatDate,
  formatDateTime,
  formatDurationSeconds,
  formatElapsed,
  formatFixed,
  formatMoney,
  formatNumber,
  formatPercent,
  formatSeconds,
} = await import('../src/components/format.js');

describe('EMPTY', () => {
  it('값이 없을 때 쓰는 en dash 다', () => {
    assert.equal(EMPTY, '–');
  });
});

describe('formatCents', () => {
  it('센트를 달러 두 자리로 보여 준다', () => {
    assert.equal(formatCents(5760), '$57.60');
    assert.equal(formatCents(0), '$0.00');
    assert.equal(formatCents(5), '$0.05');
    assert.equal(formatCents(123456), '$1234.56');
  });
  it('소수 센트(수수료)는 반올림하고 문자열 숫자도 받는다', () => {
    assert.equal(formatCents(12.345), '$0.12');
    assert.equal(formatCents(12.5), '$0.13');
    assert.equal(formatCents('250'), '$2.50');
  });
});

describe('formatPercent', () => {
  it('비율을 정수 % 로 반올림한다', () => {
    assert.equal(formatPercent(0.4167), '42%');
    assert.equal(formatPercent(0), '0%');
    assert.equal(formatPercent(1), '100%');
    assert.equal(formatPercent(0.125), '13%');
  });
  it('null, undefined 는 EMPTY 다', () => {
    assert.equal(formatPercent(null), EMPTY);
    assert.equal(formatPercent(undefined), EMPTY);
  });
});

describe('formatDateTime / formatDate (TZ=UTC)', () => {
  it('이 테스트는 UTC 를 가정한다', () => {
    assert.equal(new Date('2026-09-22T05:07:09Z').getTimezoneOffset(), 0);
  });
  it('ISO 8601 → "YYYY-MM-DD HH:mm"', () => {
    assert.equal(formatDateTime('2026-09-22T05:07:09Z'), '2026-09-22 05:07');
    assert.equal(formatDateTime('2026-09-22T05:07:09.123Z', true), '2026-09-22 05:07:09');
    assert.equal(formatDateTime('2026-01-05T00:00:00Z'), '2026-01-05 00:00');
  });
  it('오프셋이 있는 값은 UTC 로 옮겨 보여 준다', () => {
    assert.equal(formatDateTime('2026-09-22T14:07:00+09:00'), '2026-09-22 05:07');
    assert.equal(formatDate('2026-09-23T03:00:00+09:00'), '2026-09-22');
  });
  it('formatDate 는 날짜만', () => {
    assert.equal(formatDate('2026-09-22T23:59:59Z'), '2026-09-22');
  });
  it('값이 없으면 EMPTY, 못 읽는 값은 그대로 돌려준다', () => {
    assert.equal(formatDateTime(''), EMPTY);
    assert.equal(formatDateTime(null), EMPTY);
    assert.equal(formatDateTime(undefined), EMPTY);
    assert.equal(formatDate(null), EMPTY);
    assert.equal(formatDateTime('not a date'), 'not a date');
    assert.equal(formatDate('not a date'), 'not a date');
  });
});

describe('formatDurationSeconds', () => {
  it('일, 시간, 분 단위를 고른다', () => {
    assert.equal(formatDurationSeconds(86400), '1 day(s)');
    assert.equal(formatDurationSeconds(259200), '3 day(s)');
    assert.equal(formatDurationSeconds(3600), '1 hour(s)');
    assert.equal(formatDurationSeconds(7200), '2 hour(s)');
    assert.equal(formatDurationSeconds(1200), '20 min');
    assert.equal(formatDurationSeconds(5400), '90 min');
    assert.equal(formatDurationSeconds(90), '2 min');
  });
  it('값이 없으면 EMPTY 다', () => {
    assert.equal(formatDurationSeconds(null), EMPTY);
    assert.equal(formatDurationSeconds(undefined), EMPTY);
  });
});

describe('formatElapsed', () => {
  it('밀리초 → "12s", "1m 05s", "1h 02m"', () => {
    assert.equal(formatElapsed(12000), '12s');
    assert.equal(formatElapsed(65000), '1m 05s');
    assert.equal(formatElapsed(3720000), '1h 02m');
    assert.equal(formatElapsed(3599000), '59m 59s');
    assert.equal(formatElapsed(0), '0s');
  });
  it('반올림하고 음수는 0 으로 본다', () => {
    assert.equal(formatElapsed(499), '0s');
    assert.equal(formatElapsed(500), '1s');
    assert.equal(formatElapsed(-500), '0s');
  });
  it('null, undefined, NaN 은 EMPTY 다', () => {
    assert.equal(formatElapsed(null), EMPTY);
    assert.equal(formatElapsed(undefined), EMPTY);
    assert.equal(formatElapsed(Number.NaN), EMPTY);
  });
});

describe('그 밖의 도우미', () => {
  it('formatSeconds', () => {
    assert.equal(formatSeconds(12.4), '12s');
    assert.equal(formatSeconds(0), '0s');
    assert.equal(formatSeconds(null), EMPTY);
  });
  it('formatMoney', () => {
    assert.equal(formatMoney('0.10'), '$0.10');
    assert.equal(formatMoney(''), EMPTY);
    assert.equal(formatMoney(null), EMPTY);
  });
  it('formatNumber', () => {
    assert.equal(formatNumber(1234567), '1,234,567');
    assert.equal(formatNumber('42'), '42');
    assert.equal(formatNumber(undefined), EMPTY);
  });
  it('formatBytes', () => {
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(1536), '1.5 KB');
    assert.equal(formatBytes(2048), '2.0 KB');
    assert.equal(formatBytes(null), EMPTY);
  });
  it('formatFixed', () => {
    assert.equal(formatFixed(0.123456), '0.123');
    assert.equal(formatFixed(0.5, 1), '0.5');
    assert.equal(formatFixed(null), EMPTY);
  });
});

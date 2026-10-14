// worker 화면의 순수 로직(src/lib/worker-tasks.js) 검사. worker 에게 보낼 입력 컬럼은 backend(app/domain/tasks.py)와 같은 규칙이어야
// 하므로 backend 테스트(test_worker_api.py 의 test_worker_columns_hide_answer_keys)와 같은 경우를 본다.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { durationText, hiddenColumns, statusLabel, timeLeft, workerColumns } from '../src/lib/worker-tasks.js';

const TASK_DATA_HTML = '<html><head></head><body><script>var d = window.TASK_DATA;</script></body></html>';
const BATCH = {
  inputColumns: ['item_id', 'passage', 'gold', 'attention_expected'],
  templateHtml: TASK_DATA_HTML,
  attentionRule: { column: 'attention_expected', minCorrectRatio: 1 },
  reference: { source: 'column', column: 'gold' },
};

describe('workerColumns', () => {
  it('TASK_DATA 템플릿이면 정답 컬럼(기대 답, 대조 기준)을 뺀다', () => {
    assert.deepEqual(hiddenColumns(BATCH), ['attention_expected', 'gold']);
    assert.deepEqual(workerColumns(BATCH), { visible: ['item_id', 'passage'], hidden: ['gold', 'attention_expected'] });
  });

  it('placeholder 가 있으면 그 컬럼만 보낸다', () => {
    assert.deepEqual(workerColumns({ ...BATCH, templateHtml: '<p>${passage}</p>' }).visible, ['passage']);
  });

  it('접두어 방식 attention 과 majority 대조 기준이면 모두 보낸다', () => {
    const plain = { ...BATCH, attentionRule: { namePrefix: 'attention_', expectedValue: 'x' }, reference: { source: 'majority' } };
    assert.deepEqual(workerColumns(plain), { visible: BATCH.inputColumns, hidden: [] });
  });
});

describe('시간과 상태 글', () => {
  it('timeLeft 는 남은 시간을 m:ss 또는 h:mm:ss 로, 지나면 0:00 과 expired', () => {
    const now = Date.parse('2026-10-14T00:00:00Z');
    assert.deepEqual(timeLeft('2026-10-14T00:29:05Z', now), { seconds: 1745, expired: false, text: '29:05' });
    assert.deepEqual(timeLeft('2026-10-14T01:02:03Z', now), { seconds: 3723, expired: false, text: '1:02:03' });
    assert.deepEqual(timeLeft('2026-10-13T23:59:00Z', now), { seconds: 0, expired: true, text: '0:00' });
    assert.equal(timeLeft(null, now).text, '–');
  });

  it('durationText 와 statusLabel', () => {
    assert.equal(durationText(1800), '30 minutes');
    assert.equal(durationText(5400), '1 hour 30 minutes');
    assert.equal(durationText(45), '45 seconds');
    assert.equal(durationText(0), '–');
    assert.equal(statusLabel('Accepted'), 'In progress');
    assert.equal(statusLabel('Submitted'), 'Pending review');
    assert.equal(statusLabel('Abandoned'), 'Time ran out');
  });
});

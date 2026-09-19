import { describe, expect, it } from 'vitest';
import type { Assignment, AssignmentStatus } from '../api/types';
import { computeWorkerStats, median, type WorkerStatsRecord } from './workerStats';

let seq = 0;

function record(
  workerId: string,
  answers: Record<string, string>,
  options: {
    status?: AssignmentStatus;
    rowIndex?: number;
    batchId?: string;
    workTime?: number;
    attentionPassed?: boolean;
    submitTime?: string;
  } = {},
): WorkerStatsRecord {
  seq += 1;
  const assignment: Assignment = {
    AssignmentId: `A${seq}`,
    HITId: `H${options.rowIndex ?? 0}`,
    WorkerId: workerId,
    AssignmentStatus: options.status ?? 'Approved',
    AcceptTime: '2025-10-09T11:00:00Z',
    SubmitTime: options.submitTime ?? '2025-10-09T11:05:00Z',
    AutoApprovalTime: '2025-11-08T11:05:00Z',
    answers: Object.entries(answers).map(([name, value]) => ({ name, value })),
    workTimeInSeconds: options.workTime ?? 300,
    attention:
      options.attentionPassed === undefined
        ? null
        : { total: 1, correct: options.attentionPassed ? 1 : 0, passed: options.attentionPassed },
  };
  return {
    assignment,
    batchId: options.batchId ?? 'b1',
    rowIndex: options.rowIndex ?? 0,
    attentionPrefix: 'attention_',
  };
}

describe('median', () => {
  it('홀수, 짝수, 빈 배열', () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});

describe('computeWorkerStats', () => {
  it('제출, 승인, 반려, 대기 수와 반려율', () => {
    const stats = computeWorkerStats([
      record('W1', { q: 'a' }, { status: 'Approved', rowIndex: 0 }),
      record('W1', { q: 'a' }, { status: 'Approved', rowIndex: 1 }),
      record('W1', { q: 'a' }, { status: 'Rejected', rowIndex: 2 }),
      record('W1', { q: 'a' }, { status: 'Submitted', rowIndex: 3 }),
    ]).get('W1')!;
    expect(stats).toMatchObject({ total: 4, approved: 2, rejected: 1, pending: 1 });
    expect(stats.rejectRate).toBeCloseTo(1 / 3);
  });

  it('검수된 건이 없으면 반려율은 null', () => {
    const stats = computeWorkerStats([record('W1', { q: 'a' }, { status: 'Submitted' })]).get('W1')!;
    expect(stats.rejectRate).toBeNull();
  });

  it('attention 실패율은 판정이 있는 assignment만 분모로 한다', () => {
    const stats = computeWorkerStats([
      record('W1', { q: 'a' }, { rowIndex: 0, attentionPassed: true }),
      record('W1', { q: 'a' }, { rowIndex: 1, attentionPassed: false }),
      record('W1', { q: 'a' }, { rowIndex: 2 }), // 판정 없음
    ]).get('W1')!;
    expect(stats.attentionFailRate).toBe(0.5);
  });

  it('작업시간 중앙값, 참여 batch 수, 마지막 활동일', () => {
    const stats = computeWorkerStats([
      record('W1', { q: 'a' }, { rowIndex: 0, workTime: 60, submitTime: '2025-10-09T11:05:00Z' }),
      record('W1', { q: 'a' }, { rowIndex: 1, workTime: 400, batchId: 'b2', submitTime: '2025-11-19T12:00:00Z' }),
      record('W1', { q: 'a' }, { rowIndex: 2, workTime: 100, submitTime: '2025-10-10T00:00:00Z' }),
    ]).get('W1')!;
    expect(stats.medianWorkTimeInSeconds).toBe(100);
    expect(stats.batchCount).toBe(2);
    expect(stats.lastActiveAt).toBe('2025-11-19T12:00:00Z');
  });

  describe('majority 일치율', () => {
    it('자기 표를 빼고 다른 worker들의 majority와 비교한다', () => {
      // q1: W1=a, W2=a, W3=b. W3 입장에서 다른 표는 [a, a] → majority a → 불일치.
      // W1 입장에서 다른 표는 [a, b] → 동률 → 제외.
      const stats = computeWorkerStats([
        record('W1', { q1: 'a' }),
        record('W2', { q1: 'a' }),
        record('W3', { q1: 'b' }),
      ]);
      expect(stats.get('W3')!.majorityAgreement).toBe(0);
      expect(stats.get('W1')!.majorityAgreement).toBeNull();
    });

    it('자기 표를 포함하면 majority가 되는 경우에도 일치로 세지 않는다', () => {
      // q1: W1=a, W2=b. 자기 표를 넣으면 동률이지만, 빼면 W1은 [b]와 비교되어 불일치다.
      const stats = computeWorkerStats([record('W1', { q1: 'a' }), record('W2', { q1: 'b' })]);
      expect(stats.get('W1')!.majorityAgreement).toBe(0);
      expect(stats.get('W2')!.majorityAgreement).toBe(0);
    });

    it('여러 문항에 걸친 비율', () => {
      const stats = computeWorkerStats([
        record('W1', { q1: 'a', q2: 'a', q3: 'b', q4: 'a' }),
        record('W2', { q1: 'a', q2: 'a', q3: 'a', q4: 'b' }),
        record('W3', { q1: 'a', q2: 'a', q3: 'a', q4: 'b' }),
      ]);
      expect(stats.get('W1')!.majorityAgreement).toBe(0.5); // q1, q2 일치 / q3, q4 불일치
      expect(stats.get('W2')!.majorityAgreement).toBe(1); // q1, q2 일치. q3, q4는 다른 표가 [b,a], [a,b] 동률이라 제외
    });

    it('attention 문항은 세지 않는다', () => {
      const stats = computeWorkerStats([
        record('W1', { q1: 'a', attention_1: 'x' }),
        record('W2', { q1: 'a', attention_1: 'y' }),
        record('W3', { q1: 'a', attention_1: 'y' }),
      ]);
      expect(stats.get('W1')!.majorityAgreement).toBe(1);
    });

    it('반려된 응답은 비교 기준에 들어가지 않지만 평가 대상은 된다', () => {
      // W4(반려)는 [a, a]와 비교되어 불일치. W1은 [a] (W2)와 비교되고 반려된 W4의 b는 기준에 없다.
      const stats = computeWorkerStats([
        record('W1', { q1: 'a' }),
        record('W2', { q1: 'a' }),
        record('W4', { q1: 'b' }, { status: 'Rejected' }),
      ]);
      expect(stats.get('W4')!.majorityAgreement).toBe(0);
      expect(stats.get('W1')!.majorityAgreement).toBe(1);
    });

    it('같은 rowIndex라도 batch가 다르면 다른 문항이다', () => {
      const stats = computeWorkerStats([
        record('W1', { q1: 'a' }, { batchId: 'b1' }),
        record('W2', { q1: 'b' }, { batchId: 'b2' }),
      ]);
      expect(stats.get('W1')!.majorityAgreement).toBeNull();
    });
  });
});

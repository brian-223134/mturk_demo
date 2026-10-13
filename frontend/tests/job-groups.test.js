// lib/job-groups.js: Generate from raw data 의 후보 묶음. 목록을 화면 항목으로 나누기, 묶음 상태와 안내, 후보마다 고를 기본 모델.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CANDIDATE_COUNT,
  candidateLabel,
  defaultCandidateModels,
  entryKey,
  groupJobs,
  groupMessage,
  groupState,
  repeatedModels,
  restoreCandidateModels,
} from '../src/lib/job-groups.js';

const MODELS = [{ name: 'deepseek-v3.2' }, { name: 'default' }, { name: 'qwen3-235b' }];
const hasResult = (job) => job.status === 'succeeded';

function member(id, index, status = 'succeeded', extra = {}) {
  return { id, name: 'groundedness', status, planner: { model_config: ['default', 'qwen3-235b', 'deepseek-v3.2'][index] }, group: { id: 'grp-1', index, size: 3, chosen_job_id: null }, ...extra };
}

describe('defaultCandidateModels / restoreCandidateModels', () => {
  it('서버 기본 설정을 먼저, 그다음 목록 순서로 서로 다른 모델을 후보 수만큼 고른다', () => {
    assert.equal(CANDIDATE_COUNT, 3);
    assert.deepEqual(defaultCandidateModels(MODELS, 'default'), ['default', 'deepseek-v3.2', 'qwen3-235b']);
    assert.deepEqual(defaultCandidateModels(MODELS, 'missing'), ['deepseek-v3.2', 'default', 'qwen3-235b']);
  });

  it('모델 설정이 후보보다 적으면 처음부터 다시 돌고, 하나도 없으면 빈 목록이다', () => {
    assert.deepEqual(defaultCandidateModels([{ name: 'default' }, { name: 'qwen3-235b' }], 'default'), ['default', 'qwen3-235b', 'default']);
    assert.deepEqual(defaultCandidateModels([], 'default'), []);
  });

  it('저장해 둔 선택은 지금 있는 모델만 살리고 나머지 자리는 기본값으로 채운다', () => {
    assert.deepEqual(restoreCandidateModels(['qwen3-235b', 'gone', ''], MODELS, 'default'), ['qwen3-235b', 'deepseek-v3.2', 'qwen3-235b']);
    assert.deepEqual(restoreCandidateModels(undefined, MODELS, 'default'), defaultCandidateModels(MODELS, 'default'));
  });

  it('repeatedModels 는 두 번 이상 고른 모델만 돌려준다', () => {
    assert.deepEqual(repeatedModels(['default', 'qwen3-235b', 'default']), ['default']);
    assert.deepEqual(repeatedModels(['default', 'qwen3-235b', 'deepseek-v3.2']), []);
  });
});

describe('groupJobs', () => {
  it('같은 group 의 job 을 처음 나온 자리에 하나로 모으고 후보 순서로 둔다. 단독 job 은 그대로 둔다', () => {
    const jobs = [member('c', 2), { id: 'single', status: 'succeeded' }, member('a', 0), member('b', 1), { id: 'old', status: 'failed' }];
    const entries = groupJobs(jobs);
    assert.deepEqual(entries.map((e) => [e.kind, e.key]), [['group', 'grp-1'], ['job', 'single'], ['job', 'old']]);
    assert.deepEqual(entries[0].jobs.map((j) => j.id), ['a', 'b', 'c']);
    assert.equal(entryKey(jobs[0]), 'grp-1');
    assert.equal(entryKey(jobs[1]), 'single');
    assert.deepEqual(groupJobs(undefined), []);
  });
});

describe('groupState / groupMessage', () => {
  it('도는 후보가 있으면 running 이고 비교할 수 없다', () => {
    const state = groupState([member('a', 0), member('b', 1, 'running'), member('c', 2, 'queued')], hasResult);
    assert.equal(state.status, 'running');
    assert.equal(state.active, 2);
    assert.match(groupMessage(state), /1 of 3 finished/);
  });

  it('모두 끝나고 하나라도 성공하면 ready, 실패한 후보는 비교 목록에서 빠진다', () => {
    const state = groupState([member('a', 0), member('b', 1, 'failed'), member('c', 2)], hasResult);
    assert.equal(state.status, 'ready');
    assert.deepEqual(state.ready.map((j) => j.id), ['a', 'c']);
    assert.equal(state.failed, 1);
    assert.equal(state.chosen, null);
    assert.equal(groupMessage(state), '2 of 3 candidates are ready to compare. 1 failed. Compare them and choose one to create the project.');
  });

  it('chosen_job_id 가 있으면 고른 후보를 알린다', () => {
    const chosen = (job) => ({ ...job, group: { ...job.group, chosen_job_id: 'b' } });
    const state = groupState([member('a', 0), member('b', 1), member('c', 2)].map(chosen), hasResult);
    assert.equal(state.chosen.id, 'b');
    assert.match(groupMessage(state), /Chosen: Candidate B · qwen3-235b\./);
  });

  it('모두 실패하면 failed', () => {
    const state = groupState([member('a', 0, 'failed'), member('b', 1, 'failed')], hasResult);
    assert.equal(state.status, 'failed');
    assert.match(groupMessage(state), /Every candidate failed/);
  });
});

describe('candidateLabel', () => {
  it('후보는 글자와 모델로, 단독 job 은 이름으로 부른다', () => {
    assert.equal(candidateLabel(member('c', 2)), 'Candidate C · deepseek-v3.2');
    assert.equal(candidateLabel({ id: 'j1', name: 'single run' }), 'single run');
    assert.equal(candidateLabel({ id: 'j1' }), 'j1');
  });
});

// Generate from raw data 의 후보 묶음. POST /api/agent/job-groups 는 같은 원본과 prompt 로 모델만 바꾼 job 을 후보 수만큼 만들고,
// 각 job 의 group 에 { id, index, size, chosen_job_id } 를 적는다. 여기서는 job 목록을 화면의 항목(후보 묶음 또는 단독 job)으로
// 나누고, 묶음의 진행 상태와 후보 이름, 후보마다 기본으로 고를 모델을 정한다. DOM 은 쓰지 않는다.

export const CANDIDATE_COUNT = 3;

const isActive = (job) => job.status === 'queued' || job.status === 'running';

/** 0 → 'A', 1 → 'B' … */
export function candidateLetter(index) {
  return String.fromCharCode(65 + (Number.isInteger(index) && index >= 0 && index < 26 ? index : 0));
}

/** 묶음의 후보는 "Candidate B · qwen3-235b", 단독 job 은 이름 그대로. */
export function candidateLabel(job) {
  if (!job.group) return job.name || job.id;
  const model = job.planner?.model_config;
  return `Candidate ${candidateLetter(job.group.index)}${model ? ` · ${model}` : ''}`;
}

/**
 * 후보마다 처음 고를 모델 설정 이름. 서버의 기본 설정을 먼저, 그다음 목록 순서대로 서로 다른 모델을 고른다.
 * 모델 설정이 후보 수보다 적으면 처음부터 다시 돈다. 모든 설정이 temperature 0 이라 같은 모델은 거의 같은 명세를 쓰기 때문이다.
 */
export function defaultCandidateModels(models, defaultName, count = CANDIDATE_COUNT) {
  const names = (models ?? []).map((m) => m.name);
  if (names.length === 0) return [];
  const ordered = names.includes(defaultName) ? [defaultName, ...names.filter((n) => n !== defaultName)] : names;
  return Array.from({ length: count }, (_, i) => ordered[i % ordered.length]);
}

/** 저장해 둔 선택을 지금 있는 모델 설정에 맞춘다. 없어진 이름이나 빈 칸은 그 자리의 기본값으로 바꾼다. */
export function restoreCandidateModels(saved, models, defaultName, count = CANDIDATE_COUNT) {
  const fallback = defaultCandidateModels(models, defaultName, count);
  const names = new Set((models ?? []).map((m) => m.name));
  return fallback.map((name, i) => (Array.isArray(saved) && names.has(saved[i]) ? saved[i] : name));
}

/** 같은 모델을 두 번 이상 고른 이름들. 화면은 이것으로 "후보가 거의 같다"고 알린다. */
export function repeatedModels(names) {
  const seen = new Set();
  const repeated = new Set();
  for (const name of names) (seen.has(name) ? repeated : seen).add(name);
  return [...repeated];
}

/**
 * job 목록(최신순) → 화면 항목. 같은 group.id 의 job 은 처음 나온 자리에 하나의 묶음으로 모으고 후보 순서(index)로 둔다.
 *   [{ kind: 'group', key, groupId, jobs }, { kind: 'job', key, job }, …]
 */
export function groupJobs(jobs) {
  const entries = [];
  const groups = new Map();
  for (const job of jobs ?? []) {
    const groupId = job.group?.id;
    if (!groupId) {
      entries.push({ kind: 'job', key: job.id, job });
      continue;
    }
    let entry = groups.get(groupId);
    if (!entry) {
      entry = { kind: 'group', key: groupId, groupId, jobs: [] };
      groups.set(groupId, entry);
      entries.push(entry);
    }
    entry.jobs.push(job);
  }
  for (const entry of groups.values()) entry.jobs.sort((a, b) => (a.group.index ?? 0) - (b.group.index ?? 0));
  return entries;
}

/** 화면 항목의 key. 묶음이면 group id, 아니면 job id. */
export function entryKey(job) {
  return job.group?.id ?? job.id;
}

/**
 * 묶음의 상태.
 *   status    'running'(아직 도는 후보가 있다) | 'ready'(하나 이상 성공) | 'failed'(모두 실패)
 *   ready     비교할 수 있는 후보 (성공했고 결과 파일이 있는 것), hasResult 로 판정한다
 *   chosen    고른 후보의 job (없으면 null)
 */
export function groupState(jobs, hasResult) {
  const active = jobs.filter(isActive).length;
  const ready = jobs.filter((job) => hasResult(job));
  const failed = jobs.filter((job) => job.status === 'failed').length;
  const chosenId = jobs.find((job) => job.group?.chosen_job_id)?.group.chosen_job_id ?? null;
  const status = active > 0 ? 'running' : ready.length > 0 ? 'ready' : 'failed';
  return { status, active, failed, total: jobs.length, ready, chosen: jobs.find((job) => job.id === chosenId) ?? null };
}

/** 묶음 카드의 한 줄 안내. */
export function groupMessage(state) {
  if (state.status === 'running') {
    const finished = state.total - state.active;
    return `Generating ${state.total} candidates at once · ${finished} of ${state.total} finished.`;
  }
  if (state.status === 'failed') return 'Every candidate failed. Open a candidate to see why, then reuse the inputs to try again.';
  const parts = [`${state.ready.length} of ${state.total} candidates are ready to compare.`];
  if (state.failed > 0) parts.push(`${state.failed} failed.`);
  if (state.chosen) parts.push(`Chosen: ${candidateLabel(state.chosen)}.`);
  else parts.push('Compare them and choose one to create the project.');
  return parts.join(' ');
}

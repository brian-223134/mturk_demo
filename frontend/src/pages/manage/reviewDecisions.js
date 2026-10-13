// Review 의 검수 결정. 응답(assignment)마다 Approve / Reject 를 라디오로 골라 두고, 한 번에 제출한다 (제출 전에는 서버에 아무것도 가지 않는다).
// HIT 단위 라디오는 그 HIT 의 응답 전부에 같은 결정을 넣는다. 검수할 수 있는 것은 Submitted 응답뿐이다.
// DOM 을 쓰지 않으므로 Node 에서 테스트한다.

export const APPROVE = 'approve';
export const REJECT = 'reject';

export const reviewable = (a) => a?.AssignmentStatus === 'Submitted';

export function createDecisions() {
  const items = new Map(); // AssignmentId → { value, assignment }
  const listeners = new Set();
  const notify = () => {
    for (const fn of listeners) fn(api);
  };
  const put = (a, value) => {
    if (!reviewable(a)) return false;
    const current = items.get(a.AssignmentId)?.value ?? null;
    if (value !== APPROVE && value !== REJECT) value = null;
    if (current === value) return false;
    if (value) items.set(a.AssignmentId, { value, assignment: a });
    else items.delete(a.AssignmentId);
    return true;
  };
  const api = {
    get size() {
      return items.size;
    },
    /** 'approve' | 'reject' | null */
    get: (a) => items.get(a.AssignmentId)?.value ?? null,
    /** value 가 null 이면 결정을 지운다. Submitted 가 아닌 응답은 무시한다 */
    set(a, value) {
      if (put(a, value)) notify();
    },
    /** 같은 결정을 여러 응답에 넣는다 (HIT 단위, attention 실패 일괄). 바뀐 응답 수를 돌려준다 */
    setMany(assignments, value) {
      let changed = 0;
      for (const a of assignments) if (put(a, value)) changed += 1;
      if (changed) notify();
      return changed;
    },
    /** 화면의 라디오: 이미 고른 값을 다시 누르면 지운다 */
    toggle(a, value) {
      api.set(a, api.get(a) === value ? null : value);
    },
    removeIds(ids) {
      let changed = false;
      for (const id of ids) changed = items.delete(id) || changed;
      if (changed) notify();
    },
    clear() {
      if (items.size === 0) return;
      items.clear();
      notify();
    },
    lists() {
      const out = { approve: [], reject: [] };
      for (const { value, assignment } of items.values()) out[value].push(assignment);
      return out;
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  return api;
}

/**
 * HIT 묶음의 결정. Submitted 응답이 없으면 'done', 모두 같은 결정이면 그 값, 아무것도 안 골랐으면 'none', 섞였으면 'mixed'.
 */
export function groupDecision(assignments, decisions) {
  const open = assignments.filter(reviewable);
  if (open.length === 0) return 'done';
  const values = new Set(open.map((a) => decisions.get(a)));
  if (values.size === 1) return [...values][0] ?? 'none';
  return 'mixed';
}

/**
 * Row 순으로 정렬된 페이지에서 같은 HIT 가 이어진 구간. 페이지 경계에 걸린 HIT 는 앞뒤 페이지(before, after)의 같은 HIT 응답을
 * outside 로 붙여, HIT 단위 결정이 페이지에 가려진 응답까지 함께 바꾸게 한다.
 *   [{ hitId, rowIndex, items, before: [...], after: [...] }]
 */
export function hitGroups(items, { before = [], after = [] } = {}) {
  const groups = [];
  for (const a of items) {
    const last = groups[groups.length - 1];
    if (last && last.hitId === a.HITId) last.items.push(a);
    else groups.push({ hitId: a.HITId, rowIndex: a.rowIndex, items: [a], before: [], after: [] });
  }
  if (groups.length > 0) {
    const first = groups[0];
    const end = groups[groups.length - 1];
    for (let i = before.length - 1; i >= 0 && before[i].HITId === first.hitId; i -= 1) first.before.unshift(before[i]);
    for (let i = 0; i < after.length && after[i].HITId === end.hitId; i += 1) end.after.push(after[i]);
  }
  return groups;
}

/** HIT 단위 결정이 바꾸는 응답 (페이지 밖 포함) */
export const groupMembers = (group) => [...group.before, ...group.items, ...group.after];

/** 결정 막대의 문구 */
export function decisionSummary({ approve, reject }) {
  const parts = [];
  if (approve.length) parts.push(`${approve.length} to approve`);
  if (reject.length) parts.push(`${reject.length} to reject`);
  return parts.join(' · ');
}

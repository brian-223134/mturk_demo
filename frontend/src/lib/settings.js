// Create (3) Settings: 폼 값과 MTurk 구조 사이의 변환. prototype/src/features/create/settings.ts 를 옮기고, 폼 검증(validateSettings),
// agent job 의 settings.json 을 폼 값에 얹는 applyJobSettings, 게시 요청을 만드는 buildCreateBatchRequest 를 더했다.
// 폼은 사람이 읽는 단위(분, 일, %)로 받고 게시할 때 초와 Qualification 구조로 바꾼다.

import { estimateCost, usesMasters } from './cost.js';
import { parseReferenceCell } from './reference.js';

export const DEFAULT_ATTENTION_PREFIX = 'attention_';

// MTurk 의 시스템 Qualification ID. Settings 폼의 세 조건이 이 ID 로 변환된다.
export const QUALIFICATION_APPROVAL_RATE = '000000000000000000L0';
export const QUALIFICATION_APPROVED_HITS = '00000000000000000040';
export const QUALIFICATION_LOCALE = '00000000000000000071';

export const MAX_AUTO_APPROVAL_DAYS = 30; // MTurk 제약
export const MIN_REWARD = '0.01';
export const COUNTRY_CODE = /^[A-Z]{2}$/;

// 보상, 기간, MaxAssignments 의 기본값은 케이스 스터디와 같게 둔다. 제목과 설명은 일반적인 문구다.
export const DEFAULT_SETTINGS = Object.freeze({
  Title: 'Sentence and passage relevance quiz',
  Description: 'Read a sentence and a passage, then assess their relevance.',
  Keywords: 'English, Reading, Sentence, Passage, Quiz',
  Reward: '0.10', // USD 문자열 ("0.10"). MTurk 와 같다
  MaxAssignments: 3,
  durationMinutes: 30, // → AssignmentDurationInSeconds
  lifetimeDays: 30, // → LifetimeInSeconds
  autoApprovalDays: 30, // → AutoApprovalDelayInSeconds

  approvalRateEnabled: false,
  approvalRate: 95, // %
  approvedHitsEnabled: false,
  approvedHits: 1000,
  countriesEnabled: false,
  countries: ['US'], // ISO 3166 두 글자 코드

  requiredPoolIds: [],
  excludedPoolIds: [],

  attentionEnabled: false,
  attentionPrefix: DEFAULT_ATTENTION_PREFIX,
  attentionExpected: '',
  attentionMinRatio: 1,

  /** Review 의 대조 기준으로 쓸 CSV 컬럼. null 이면 같은 HIT 의 다른 worker 들 majority */
  referenceColumn: null,
});

/** 기본값의 깊은 복사 (배열을 공유하지 않게). */
export function defaultSettings() {
  return { ...DEFAULT_SETTINGS, countries: [...DEFAULT_SETTINGS.countries], requiredPoolIds: [], excludedPoolIds: [] };
}

const MINUTE = 60;
const DAY = 24 * 60 * 60;

export function buildQualificationRequirements(values) {
  const requirements = [];
  if (values.approvalRateEnabled) {
    requirements.push({ QualificationTypeId: QUALIFICATION_APPROVAL_RATE, Comparator: 'GreaterThanOrEqualTo', IntegerValues: [values.approvalRate] });
  }
  if (values.approvedHitsEnabled) {
    requirements.push({ QualificationTypeId: QUALIFICATION_APPROVED_HITS, Comparator: 'GreaterThanOrEqualTo', IntegerValues: [values.approvedHits] });
  }
  if (values.countriesEnabled && values.countries.length > 0) {
    requirements.push({ QualificationTypeId: QUALIFICATION_LOCALE, Comparator: 'In', LocaleValues: values.countries.map((Country) => ({ Country })) });
  }
  return requirements;
}

/** "0.1" → "0.10". 숫자가 아니면 그대로 둔다 (서버 검증이 걸러 낸다). */
export function normalizeReward(reward) {
  const dollars = Number.parseFloat(reward);
  return Number.isFinite(dollars) ? dollars.toFixed(2) : reward;
}

export function toHitSettings(values) {
  return {
    Title: values.Title.trim(),
    Description: values.Description.trim(),
    Keywords: values.Keywords.trim(),
    Reward: normalizeReward(values.Reward),
    MaxAssignments: values.MaxAssignments,
    AssignmentDurationInSeconds: Math.round(values.durationMinutes * MINUTE),
    LifetimeInSeconds: Math.round(values.lifetimeDays * DAY),
    AutoApprovalDelayInSeconds: Math.round(values.autoApprovalDays * DAY),
    QualificationRequirements: buildQualificationRequirements(values),
  };
}

export function toAttentionRule(values) {
  if (!values.attentionEnabled) return null;
  return { namePrefix: values.attentionPrefix, expectedValue: values.attentionExpected, minCorrectRatio: values.attentionMinRatio };
}

/** 컬럼을 고르지 않았으면(null 또는 빈 문자열) majority. GT 나 LLM 라벨이 없는 CSV 가 흔하므로 이것이 기본이다. */
export function toReviewReference(values) {
  const column = (values.referenceColumn ?? '').trim();
  return column === '' ? { source: 'majority' } : { source: 'column', column };
}

const REFERENCE_VALUE_PREVIEW = 40;

/** 고른 컬럼의 첫 행 셀이 어떤 형식으로 읽히는지 한 줄로 { type: 'info'|'warning', message }. Settings 화면의 안내에 쓴다. */
export function describeReferenceCell(cell) {
  const parsed = parseReferenceCell(cell);
  if (parsed === undefined) return { type: 'warning', message: 'Row 1 is empty; answers in that row will show no reference.' };
  if (parsed === null) return { type: 'warning', message: 'Row 1 reads as null; answers in that row will show no reference.' };
  if (Array.isArray(parsed)) {
    return { type: 'info', message: `Row 1 reads as a list of ${parsed.length} values (matched to answers by position).` };
  }
  if (typeof parsed === 'object') {
    const count = Object.keys(parsed).length;
    return { type: 'info', message: `Row 1 reads as an object with ${count} entries (matched to answers by name).` };
  }
  const text = String(parsed);
  const shown = text.length > REFERENCE_VALUE_PREVIEW ? `${text.slice(0, REFERENCE_VALUE_PREVIEW)}…` : text;
  return { type: 'info', message: `Row 1 reads as a single value "${shown}" (used when the task has exactly one answer besides attention items).` };
}

/** 견적. 저장된 draft 의 값이 깨져 있어도(예: Reward 가 빈 문자열) 화면이 죽지 않게 null 을 돌려준다. */
export function estimateFor(values, hitCount) {
  try {
    return estimateCost({
      hitCount,
      maxAssignments: values.MaxAssignments,
      reward: values.Reward,
      masters: usesMasters(buildQualificationRequirements(values)),
    });
  } catch {
    return null;
  }
}

/** 잔액을 센트로. 아직 못 받았거나 숫자가 아니면 null */
export function balanceCentsOf(account) {
  if (!account) return null;
  const dollars = Number.parseFloat(account.AvailableBalance);
  return Number.isFinite(dollars) ? Math.round(dollars * 100) : null;
}

/** Publish 단계의 요약에 쓰는 한 줄 설명 */
export function describeQualifications(values) {
  const lines = [];
  if (values.approvalRateEnabled) lines.push(`HIT approval rate ≥ ${values.approvalRate}%`);
  if (values.approvedHitsEnabled) lines.push(`Approved HITs ≥ ${Number(values.approvedHits).toLocaleString('en-US')}`);
  if (values.countriesEnabled && values.countries.length > 0) lines.push(`Location in ${values.countries.join(', ')}`);
  return lines;
}

/** 국가 코드 입력을 두 글자 대문자 코드로 맞춘다. 문자열이면 쉼표와 공백으로 나눈다. */
export function normalizeCountries(codes) {
  const list = Array.isArray(codes) ? codes : String(codes ?? '').split(/[\s,]+/);
  return [...new Set(list.map((code) => code.trim().toUpperCase()).filter(Boolean))];
}

const isInteger = (n) => Number.isInteger(n);
const isNumber = (n) => typeof n === 'number' && Number.isFinite(n);

/**
 * Next 를 누를 때의 검사. { 필드이름: 문구 } 를 돌려주며 비어 있으면 통과다. 문구는 프로토타입 SettingsStep 의 규칙과 같다.
 * columns 는 올린 CSV 의 컬럼(대조 기준 컬럼이 아직 있는지), pools 는 pool 목록(양쪽에 같은 pool 을 넣었을 때 이름을 쓰려고)이다.
 */
export function validateSettings(values, { columns = [], pools = [] } = {}) {
  const errors = {};
  if (!values.Title || values.Title.trim() === '') errors.Title = 'Enter a title.';
  if (!values.Description || values.Description.trim() === '') errors.Description = 'Enter a description.';

  const reward = values.Reward;
  if (reward === null || reward === undefined || String(reward).trim() === '') errors.Reward = 'Enter a reward.';
  else if (!Number.isFinite(Number.parseFloat(reward)) || Number.parseFloat(reward) < Number.parseFloat(MIN_REWARD)) {
    errors.Reward = `The minimum reward is $${MIN_REWARD}.`;
  }
  if (!isInteger(values.MaxAssignments) || values.MaxAssignments < 1) errors.MaxAssignments = 'Enter a whole number, 1 or more.';
  if (!isNumber(values.durationMinutes) || values.durationMinutes < 1) errors.durationMinutes = 'Enter at least 1 minute.';
  if (!isNumber(values.lifetimeDays) || values.lifetimeDays < 1) errors.lifetimeDays = 'Enter at least 1 day.';
  if (!isNumber(values.autoApprovalDays) || values.autoApprovalDays < 1 || values.autoApprovalDays > MAX_AUTO_APPROVAL_DAYS) {
    errors.autoApprovalDays = `Enter 1 to ${MAX_AUTO_APPROVAL_DAYS} days.`;
  }

  if (values.approvalRateEnabled && (!isInteger(values.approvalRate) || values.approvalRate < 0 || values.approvalRate > 100)) {
    errors.approvalRate = 'Enter 0 to 100.';
  }
  if (values.approvedHitsEnabled && (!isInteger(values.approvedHits) || values.approvedHits < 0)) errors.approvedHits = 'Enter 0 or more.';
  if (values.countriesEnabled) {
    const codes = values.countries ?? [];
    if (codes.length === 0) errors.countries = 'Choose at least one country.';
    else {
      const bad = codes.filter((code) => !COUNTRY_CODE.test(code));
      if (bad.length > 0) errors.countries = `Use two-letter country codes (ISO 3166). Not valid: ${bad.join(', ')}`;
    }
  }

  const both = (values.excludedPoolIds ?? []).filter((id) => (values.requiredPoolIds ?? []).includes(id));
  if (both.length > 0) {
    const names = both.map((id) => pools.find((p) => p.id === id)?.name ?? id);
    errors.excludedPoolIds = `A pool cannot be both required and excluded: ${names.join(', ')}`;
  }

  if (values.attentionEnabled) {
    if (!values.attentionPrefix || values.attentionPrefix.trim() === '') errors.attentionPrefix = 'Enter the prefix.';
    if (!values.attentionExpected || values.attentionExpected.trim() === '') errors.attentionExpected = 'Enter the expected value, e.g. not_grounded.';
    if (!isNumber(values.attentionMinRatio) || values.attentionMinRatio < 0 || values.attentionMinRatio > 1) errors.attentionMinRatio = 'Enter a value from 0 to 1.';
  }

  const column = values.referenceColumn;
  if (column && !columns.includes(column)) {
    errors.referenceColumn = `Column "${column}" is not in the uploaded CSV. Choose another column or the majority.`;
  }
  return errors;
}

/**
 * agent job 의 settings.json 을 폼 값에 얹는다. 있는 키만 바꾼다 (agent/README.md "출력 파일"의 settings.json).
 *  - Title, Description, Keywords: 그대로
 *  - attentionRule { namePrefix, expectedValue, minCorrectRatio }: 있으면 스위치를 켠다. null 이면 끈다
 *  - reference.column 또는 referenceColumn: CSV(columns)에 있는 컬럼일 때만 고른다
 *  - Reward, MaxAssignments, AssignmentDurationInSeconds, LifetimeInSeconds, AutoApprovalDelayInSeconds: 있으면 폼 단위로 바꿔 넣는다
 */
export function applyJobSettings(values, json, columns = []) {
  const next = { ...values };
  if (!json || typeof json !== 'object') return next;
  for (const key of ['Title', 'Description', 'Keywords']) {
    if (typeof json[key] === 'string') next[key] = json[key];
  }
  if (json.attentionRule && typeof json.attentionRule === 'object') {
    const rule = json.attentionRule;
    next.attentionEnabled = true;
    if (typeof rule.namePrefix === 'string' && rule.namePrefix !== '') next.attentionPrefix = rule.namePrefix;
    if (rule.expectedValue !== undefined && rule.expectedValue !== null) next.attentionExpected = String(rule.expectedValue);
    if (isNumber(rule.minCorrectRatio)) next.attentionMinRatio = rule.minCorrectRatio;
  } else if (json.attentionRule === null) {
    next.attentionEnabled = false;
  }
  const column = json.reference && json.reference.source === 'column' ? json.reference.column : json.referenceColumn;
  if (typeof column === 'string' && column !== '') next.referenceColumn = columns.includes(column) ? column : null;

  if (json.Reward !== undefined && json.Reward !== null && Number.isFinite(Number.parseFloat(json.Reward))) next.Reward = normalizeReward(String(json.Reward));
  if (isInteger(json.MaxAssignments) && json.MaxAssignments >= 1) next.MaxAssignments = json.MaxAssignments;
  if (isNumber(json.AssignmentDurationInSeconds) && json.AssignmentDurationInSeconds > 0) next.durationMinutes = Math.max(1, Math.round(json.AssignmentDurationInSeconds / MINUTE));
  if (isNumber(json.LifetimeInSeconds) && json.LifetimeInSeconds > 0) next.lifetimeDays = Math.max(1, Math.round(json.LifetimeInSeconds / DAY));
  if (isNumber(json.AutoApprovalDelayInSeconds) && json.AutoApprovalDelayInSeconds > 0) {
    next.autoApprovalDays = Math.min(MAX_AUTO_APPROVAL_DAYS, Math.max(1, Math.round(json.AutoApprovalDelayInSeconds / DAY)));
  }
  return next;
}

/** POST /api/batches 의 body (CreateBatchRequest). answerSchema 는 비어 있으면 넣지 않는다. */
export function buildCreateBatchRequest({ name, template, data, settings, answerSchema = [] }) {
  return {
    name: name.trim(),
    templateId: template.id,
    rows: data.rows,
    inputColumns: data.columns,
    settings: toHitSettings(settings),
    attentionRule: toAttentionRule(settings),
    reference: toReviewReference(settings),
    requiredPoolIds: settings.requiredPoolIds,
    excludedPoolIds: settings.excludedPoolIds,
    ...(answerSchema.length > 0 ? { answerSchema } : {}),
  };
}

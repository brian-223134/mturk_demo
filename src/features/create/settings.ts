// 5.2 (3) Settings: 폼 값과 MTurk 구조 사이의 변환. 폼은 사람이 읽는 단위(분, 일, %)로 받고 게시할 때 초와 Qualification 구조로 바꾼다.

import type { Account, AttentionRule, HitSettings, QualificationRequirement, ReviewReference } from '../../api/types';
import { DEFAULT_ATTENTION_PREFIX } from '../../domain/attention';
import { estimateCost, usesMasters, type CostEstimate } from '../../domain/cost';
import { parseReferenceCell } from '../../domain/reference';

export interface SettingsValues {
  Title: string;
  Description: string;
  Keywords: string;
  Reward: string; // USD 문자열 ("0.10"). MTurk와 같다
  MaxAssignments: number;
  durationMinutes: number; // → AssignmentDurationInSeconds
  lifetimeDays: number; // → LifetimeInSeconds
  autoApprovalDays: number; // → AutoApprovalDelayInSeconds

  approvalRateEnabled: boolean;
  approvalRate: number; // %
  approvedHitsEnabled: boolean;
  approvedHits: number;
  countriesEnabled: boolean;
  countries: string[]; // ISO 3166 두 글자 코드

  requiredPoolIds: string[];
  excludedPoolIds: string[];

  attentionEnabled: boolean;
  attentionPrefix: string;
  attentionExpected: string;
  attentionMinRatio: number;

  /** Review의 대조 기준으로 쓸 CSV 컬럼. null이면 같은 HIT의 다른 worker들 majority */
  referenceColumn: string | null;
}

// 11장의 시스템 Qualification ID. Settings 폼의 세 조건이 이 ID로 변환된다.
export const QUALIFICATION_APPROVAL_RATE = '000000000000000000L0';
export const QUALIFICATION_APPROVED_HITS = '00000000000000000040';
export const QUALIFICATION_LOCALE = '00000000000000000071';

export const MAX_AUTO_APPROVAL_DAYS = 30; // MTurk 제약 (11장)
export const MIN_REWARD = '0.01';

// 보상, 기간, MaxAssignments의 기본값은 케이스 스터디와 같게 둔다 (5.2, 부록 B). 제목과 설명은 일반적인 문구다.
export const DEFAULT_SETTINGS: SettingsValues = {
  Title: 'Sentence and passage relevance quiz',
  Description: 'Read a sentence and a passage, then assess their relevance.',
  Keywords: 'English, Reading, Sentence, Passage, Quiz',
  Reward: '0.10',
  MaxAssignments: 3,
  durationMinutes: 30,
  lifetimeDays: 30,
  autoApprovalDays: 30,

  approvalRateEnabled: false,
  approvalRate: 95,
  approvedHitsEnabled: false,
  approvedHits: 1000,
  countriesEnabled: false,
  countries: ['US'],

  requiredPoolIds: [],
  excludedPoolIds: [],

  attentionEnabled: false,
  attentionPrefix: DEFAULT_ATTENTION_PREFIX,
  attentionExpected: '',
  attentionMinRatio: 1,

  referenceColumn: null,
};

const MINUTE = 60;
const DAY = 24 * 60 * 60;

export function buildQualificationRequirements(values: SettingsValues): QualificationRequirement[] {
  const requirements: QualificationRequirement[] = [];
  if (values.approvalRateEnabled) {
    requirements.push({
      QualificationTypeId: QUALIFICATION_APPROVAL_RATE,
      Comparator: 'GreaterThanOrEqualTo',
      IntegerValues: [values.approvalRate],
    });
  }
  if (values.approvedHitsEnabled) {
    requirements.push({
      QualificationTypeId: QUALIFICATION_APPROVED_HITS,
      Comparator: 'GreaterThanOrEqualTo',
      IntegerValues: [values.approvedHits],
    });
  }
  if (values.countriesEnabled && values.countries.length > 0) {
    requirements.push({
      QualificationTypeId: QUALIFICATION_LOCALE,
      Comparator: 'In',
      LocaleValues: values.countries.map((Country) => ({ Country })),
    });
  }
  return requirements;
}

/** "0.1" → "0.10". 숫자가 아니면 그대로 둔다 (서버 검증이 걸러 낸다). */
export function normalizeReward(reward: string): string {
  const dollars = Number.parseFloat(reward);
  return Number.isFinite(dollars) ? dollars.toFixed(2) : reward;
}

export function toHitSettings(values: SettingsValues): HitSettings {
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

export function toAttentionRule(values: SettingsValues): AttentionRule | null {
  if (!values.attentionEnabled) return null;
  return {
    namePrefix: values.attentionPrefix,
    expectedValue: values.attentionExpected,
    minCorrectRatio: values.attentionMinRatio,
  };
}

/** 컬럼을 고르지 않았으면(null 또는 빈 문자열) majority. GT나 LLM 라벨이 없는 CSV가 흔하므로 이것이 기본이다. */
export function toReviewReference(values: SettingsValues): ReviewReference {
  const column = values.referenceColumn?.trim() ?? '';
  return column === '' ? { source: 'majority' } : { source: 'column', column };
}

export interface ReferenceCellNote {
  type: 'info' | 'warning';
  message: string;
}

const REFERENCE_VALUE_PREVIEW = 40;

/** 고른 컬럼의 첫 행 셀이 어떤 형식으로 읽히는지 한 줄로. Settings 화면의 안내에 쓴다. */
export function describeReferenceCell(cell: string): ReferenceCellNote {
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
  return {
    type: 'info',
    message: `Row 1 reads as a single value "${shown}" (used when the task has exactly one answer besides attention items).`,
  };
}

/** 8.1 견적. 저장된 draft의 값이 깨져 있어도(예: Reward가 빈 문자열) 화면이 죽지 않게 null을 돌려준다. */
export function estimateFor(values: SettingsValues, hitCount: number): CostEstimate | null {
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
export function balanceCentsOf(account: Account | undefined): number | null {
  if (!account) return null;
  const dollars = Number.parseFloat(account.AvailableBalance);
  return Number.isFinite(dollars) ? Math.round(dollars * 100) : null;
}

/** Publish 단계의 요약에 쓰는 한 줄 설명 */
export function describeQualifications(values: SettingsValues): string[] {
  const lines: string[] = [];
  if (values.approvalRateEnabled) lines.push(`HIT approval rate ≥ ${values.approvalRate}%`);
  if (values.approvedHitsEnabled) lines.push(`Approved HITs ≥ ${values.approvedHits.toLocaleString()}`);
  if (values.countriesEnabled && values.countries.length > 0) lines.push(`Location in ${values.countries.join(', ')}`);
  return lines;
}

/** Select의 tags 입력을 두 글자 대문자 코드로 맞춘다. */
export function normalizeCountries(codes: string[]): string[] {
  return [...new Set(codes.map((code) => code.trim().toUpperCase()).filter(Boolean))];
}

export const COUNTRY_CODE = /^[A-Z]{2}$/;

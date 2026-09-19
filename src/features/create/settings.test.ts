import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  balanceCentsOf,
  buildQualificationRequirements,
  estimateFor,
  normalizeCountries,
  toAttentionRule,
  toHitSettings,
} from './settings';

describe('toHitSettings', () => {
  it('converts the case-study defaults to MTurk units (spec 5.2, appendix B)', () => {
    expect(toHitSettings(DEFAULT_SETTINGS)).toEqual({
      Title: 'Sentence and passage relevance quiz',
      Description: 'Read a sentence and a passage, then assess their relevance.',
      Keywords: 'English, Reading, Sentence, Passage, Quiz',
      Reward: '0.10',
      MaxAssignments: 3,
      AssignmentDurationInSeconds: 30 * 60,
      LifetimeInSeconds: 30 * 24 * 3600,
      AutoApprovalDelayInSeconds: 30 * 24 * 3600,
      QualificationRequirements: [],
    });
  });

  it('normalizes the reward to two decimals and trims text', () => {
    const settings = toHitSettings({ ...DEFAULT_SETTINGS, Reward: '0.2', Title: '  Quiz  ' });
    expect(settings.Reward).toBe('0.20');
    expect(settings.Title).toBe('Quiz');
  });
});

describe('buildQualificationRequirements', () => {
  it('maps the three form rows to the MTurk system qualifications (spec 11)', () => {
    const requirements = buildQualificationRequirements({
      ...DEFAULT_SETTINGS,
      approvalRateEnabled: true,
      approvalRate: 98,
      approvedHitsEnabled: true,
      approvedHits: 500,
      countriesEnabled: true,
      countries: ['US', 'CA'],
    });
    expect(requirements).toEqual([
      { QualificationTypeId: '000000000000000000L0', Comparator: 'GreaterThanOrEqualTo', IntegerValues: [98] },
      { QualificationTypeId: '00000000000000000040', Comparator: 'GreaterThanOrEqualTo', IntegerValues: [500] },
      { QualificationTypeId: '00000000000000000071', Comparator: 'In', LocaleValues: [{ Country: 'US' }, { Country: 'CA' }] },
    ]);
  });

  it('ignores rows that are switched off, whatever value they hold', () => {
    expect(buildQualificationRequirements({ ...DEFAULT_SETTINGS, approvalRate: 99, countries: ['KR'] })).toEqual([]);
  });
});

describe('toAttentionRule', () => {
  it('is null when the template has no attention checks', () => {
    expect(toAttentionRule({ ...DEFAULT_SETTINGS, attentionExpected: 'not_grounded' })).toBeNull();
  });

  it('builds the rule when switched on', () => {
    expect(toAttentionRule({ ...DEFAULT_SETTINGS, attentionEnabled: true, attentionExpected: 'not_grounded' })).toEqual({
      namePrefix: 'attention_',
      expectedValue: 'not_grounded',
      minCorrectRatio: 1,
    });
  });
});

describe('estimateFor', () => {
  it('matches the spec 8.1 example: 160 HITs x 3 x $0.10 = $48.00 + $9.60', () => {
    expect(estimateFor(DEFAULT_SETTINGS, 160)).toEqual({ rewardCents: 4800, feeCents: 960, totalCents: 5760, feePercent: 20 });
  });

  it('returns null instead of throwing on a broken reward', () => {
    expect(estimateFor({ ...DEFAULT_SETTINGS, Reward: '' }, 10)).toBeNull();
  });
});

describe('helpers', () => {
  it('normalizes typed country codes', () => {
    expect(normalizeCountries([' us', 'US', 'gb ', ''])).toEqual(['US', 'GB']);
  });

  it('reads the balance in cents', () => {
    expect(balanceCentsOf({ env: 'mock', AvailableBalance: '500.00' })).toBe(50000);
    expect(balanceCentsOf(undefined)).toBeNull();
  });
});

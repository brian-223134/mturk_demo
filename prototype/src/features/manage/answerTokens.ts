// Review 표의 Answers 열에 쓰는 답 값의 약어. 순수 함수라 화면 없이 테스트한다.

import { normalizeLabel } from '../../domain/reference';

const WORD_SPLIT = /[^A-Za-z0-9]+/;

/** 빈 값(공백만 있는 값 포함)의 토큰. 빈 칸으로 두면 답이 없는 것처럼 보인다 */
export const EMPTY_TOKEN = '(empty)';

interface Group {
  originals: string[]; // normalizeLabel이 같은 원래 값들 (정렬 순서)
  words: string[]; // 소문자 단어. 없으면 약어를 만들 수 없다
  level: number; // 첫 단어에서 쓰는 글자 수
  full: boolean; // 더 늘릴 수 없어 값 전체를 쓴다
}

/** 첫 단어의 앞 `level` 글자(첫 글자만 대문자) + 나머지 단어의 첫 글자 대문자 */
function tokenAt(words: string[], level: number): string {
  const [first = '', ...rest] = words;
  const head = first.slice(0, level);
  return head.charAt(0).toUpperCase() + head.slice(1) + rest.map((w) => w.charAt(0).toUpperCase()).join('');
}

function tokenOf(group: Group, original: string): string {
  if (!group.full) return tokenAt(group.words, group.level);
  return original.trim() === '' ? EMPTY_TOKEN : original;
}

/**
 * 값 목록을 짧은 토큰으로 (원래 값 → 토큰). 값을 `/[^A-Za-z0-9]+/`로 나눈 단어들의 첫 글자를 대문자로 이어
 * 붙인다 (grounded → G, not_grounded → NG, Not Covered → NC). 겹치면 첫 단어의 글자를 2, 3, …개로 늘려
 * 구분하고, 그래도 겹치면 값 전체를 쓴다. 입력을 정렬해 두므로 같은 집합이면 같은 결과가 나온다.
 * normalizeLabel이 같은 값(`Not covered`와 `Not Covered`)은 한 값으로 보고 같은 토큰을 준다.
 */
export function abbreviate(values: string[]): Map<string, string> {
  const groups = new Map<string, Group>();
  for (const value of [...new Set(values)].sort()) {
    const key = normalizeLabel(value);
    const existing = groups.get(key);
    if (existing) {
      existing.originals.push(value);
      continue;
    }
    const words = key.split(WORD_SPLIT).filter(Boolean);
    groups.set(key, { originals: [value], words, level: 1, full: words.length === 0 });
  }

  // 겹치는 토큰이 없어질 때까지 겹친 그룹의 글자 수를 늘린다. full인 그룹은 원래 값이 서로 다르므로 언젠가 끝난다
  for (;;) {
    const byToken = new Map<string, Group[]>();
    for (const group of groups.values()) {
      for (const original of group.originals) {
        const token = tokenOf(group, original);
        const holders = byToken.get(token) ?? [];
        if (!holders.includes(group)) holders.push(group);
        byToken.set(token, holders);
      }
    }
    let changed = false;
    for (const holders of byToken.values()) {
      if (holders.length < 2) continue;
      for (const group of holders) {
        if (group.full) continue;
        if (group.level < (group.words[0]?.length ?? 0)) group.level += 1;
        else group.full = true;
        changed = true;
      }
    }
    if (!changed) break;
  }

  const tokens = new Map<string, string>();
  for (const group of groups.values()) {
    for (const original of group.originals) tokens.set(original, tokenOf(group, original));
  }
  return tokens;
}

/**
 * 범례용: 토큰 → 그 토큰이 뜻하는 값들 (토큰과 값이 같은 것은 뺀다). 토큰 순으로 정렬.
 * 값이 여럿이면 normalizeLabel이 같은 표기 차이다.
 */
export function legendEntries(tokens: Map<string, string>): { token: string; values: string[] }[] {
  const byToken = new Map<string, string[]>();
  for (const [value, token] of tokens) {
    if (token === value) continue;
    byToken.set(token, [...(byToken.get(token) ?? []), value]);
  }
  return [...byToken].map(([token, values]) => ({ token, values })).sort((a, b) => a.token.localeCompare(b.token));
}

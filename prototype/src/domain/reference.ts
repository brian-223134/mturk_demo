// Review 표의 대조 기준 (MTurk의 Input.GroundTruth 역할). 입력 컬럼의 값을 문항에 대응시키거나,
// 컬럼이 없으면 같은 HIT의 다른 worker들 majority를 쓴다.

import { majorityOfTally } from './agreement';
import { isAttentionName } from './attention';

/** 값 비교용. 대소문자와 앞뒤 공백을 무시한다 (LLM 라벨 `Not covered` ↔ worker 답 `Not Covered`). 표시는 원래 문자열로 한다. */
export function normalizeLabel(value: string): string {
  return value.trim().toLowerCase();
}

const PYTHON_WORDS: Record<string, string> = { True: 'true', False: 'false', None: 'null' };
const PYTHON_ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', "'": "'", '"': '"', '\\': '\\' };

/**
 * Python repr(작은따옴표 문자열, True/False/None)을 JSON 텍스트로 바꾼다. 문자열 안은 이스케이프를 풀어
 * JSON 문자열로 다시 쓰고, 밖은 True/False/None만 바꾼다. 닫히지 않은 문자열이면 undefined.
 */
function pythonToJson(text: string): string | undefined {
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] !== "'") {
      const next = text.indexOf("'", i);
      const end = next < 0 ? text.length : next;
      out += text.slice(i, end).replace(/\b(True|False|None)\b/g, (word) => PYTHON_WORDS[word]!);
      i = end;
      continue;
    }
    let inner = '';
    i += 1;
    while (i < text.length && text[i] !== "'") {
      if (text[i] !== '\\') {
        inner += text[i];
        i += 1;
        continue;
      }
      const code = text[i + 1] ?? '';
      if (code === 'x' || code === 'u') {
        const hex = text.slice(i + 2, i + (code === 'x' ? 4 : 6));
        if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== (code === 'x' ? 2 : 4)) return undefined;
        inner += String.fromCharCode(Number.parseInt(hex, 16));
        i += 2 + hex.length;
      } else {
        inner += PYTHON_ESCAPES[code] ?? code;
        i += 2;
      }
    }
    if (i >= text.length) return undefined;
    i += 1;
    out += JSON.stringify(inner);
  }
  return out;
}

/**
 * 셀 문자열을 값으로. JSON → 실패하면 Python 리터럴을 JSON으로 바꿔 다시 시도 → 그래도 안 되면 셀 전체를 값 하나로 본다
 * (문항이 하나인 과제의 GT 컬럼은 `grounded`처럼 평문이다). 빈 셀은 undefined.
 * Python 변환은 셀에 큰따옴표가 없을 때만 한다 (repr은 작은따옴표가 든 문자열을 큰따옴표로 감싼다). eval은 쓰지 않는다.
 */
export function parseReferenceCell(cell: string): unknown {
  const text = cell.trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    // Python 리터럴로 다시 시도한다
  }
  if (text.includes('"')) return text;
  const json = pythonToJson(text);
  if (json === undefined) return text;
  try {
    return JSON.parse(json);
  } catch {
    return text;
  }
}

function asLabel(value: unknown): string | undefined {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : undefined;
}

/**
 * 파싱된 값을 이 assignment의 문항 이름에 대응시킨다.
 * - object: 문항 이름과 같은 키, 없으면 `name.startsWith(key + '_')`인 키 중 가장 긴 것
 *   (답 이름 `general_0_1_coverage` ↔ 라벨 키 `general_0_1`). 값은 string|number|boolean만 문자열로. 그 외는 무시
 * - array: 위치로 대응. 길이가 답 수와 같으면 모든 답에, attention을 뺀 답 수와 같으면 attention을 뺀 답에. 둘 다 아니면 대응 없음
 * - 그 외 스칼라: attention을 뺀 답이 정확히 하나일 때 그 답에
 */
export function mapReferenceToAnswers(
  parsed: unknown,
  answers: { name: string }[],
  attentionPrefix: string,
): Record<string, string> {
  const reference: Record<string, string> = {};
  if (parsed === null || parsed === undefined) return reference;

  if (Array.isArray(parsed)) {
    const general = answers.filter((a) => !isAttentionName(a.name, attentionPrefix));
    const targets = parsed.length === answers.length ? answers : parsed.length === general.length ? general : [];
    targets.forEach((answer, index) => {
      const label = asLabel(parsed[index]);
      if (label !== undefined) reference[answer.name] = label;
    });
    return reference;
  }

  if (typeof parsed === 'object') {
    const entries = Object.entries(parsed as Record<string, unknown>);
    for (const answer of answers) {
      let bestKey: string | undefined;
      for (const [key] of entries) {
        if (answer.name !== key && !answer.name.startsWith(`${key}_`)) continue;
        if (bestKey === undefined || key.length > bestKey.length) bestKey = key;
      }
      if (bestKey === undefined) continue;
      const label = asLabel((parsed as Record<string, unknown>)[bestKey]);
      if (label !== undefined) reference[answer.name] = label;
    }
    return reference;
  }

  const label = asLabel(parsed);
  const general = answers.filter((a) => !isAttentionName(a.name, attentionPrefix));
  if (label !== undefined && general.length === 1) reference[general[0]!.name] = label;
  return reference;
}

/** 다른 worker들(반려 제외)의 답으로 문항별 majority. 동률이거나 표가 없는 문항은 키가 없다. */
export function majorityReference(others: { name: string; value: string }[][]): Record<string, string> {
  const tallies = new Map<string, Map<string, number>>();
  for (const answers of others) {
    for (const a of answers) {
      const counts = tallies.get(a.name) ?? new Map<string, number>();
      counts.set(a.value, (counts.get(a.value) ?? 0) + 1);
      tallies.set(a.name, counts);
    }
  }
  const reference: Record<string, string> = {};
  for (const [name, counts] of tallies) {
    const winner = majorityOfTally(counts);
    if (winner !== null) reference[name] = winner;
  }
  return reference;
}

/** attention 문항을 빼고 reference가 있는 문항만 비교한 일치 비율. 비교할 문항이 없으면 null. */
export function agreementWithReference(
  answers: { name: string; value: string }[],
  reference: Record<string, string>,
  attentionPrefix: string,
): number | null {
  let compared = 0;
  let agreed = 0;
  for (const a of answers) {
    if (isAttentionName(a.name, attentionPrefix)) continue;
    const expected = reference[a.name];
    if (expected === undefined) continue;
    compared += 1;
    if (normalizeLabel(expected) === normalizeLabel(a.value)) agreed += 1;
  }
  return compared === 0 ? null : agreed / compared;
}

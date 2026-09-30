// Create (4) Preview & Cost 의 "Answer fields" 카드: 미리보기가 보고한 문항 목록(answerSchema)을 Settings 의 attention 규칙과
// 자유 서술 접미어에 맞춰 본다. DOM 을 쓰지 않아 Node 에서 테스트한다.
//
// answerSchema 의 항목은 { name, values, type?, required? } 다. 템플릿이 window.TASK_ANSWER_SCHEMA 를 두면 type 이 있고
// (choice | multi_select | likert | text), 없으면 미리보기가 화면의 라디오, 체크박스, select 를 훑은 것이라 type 이 없고 글 입력칸도 없다.
// 그래서 자유 서술 검사는 type 이 있는 목록에서만 한다.

import { parseReferenceCell } from './reference.js';
import { normalizeSuffixes } from './settings.js';

const LISTED = 5;

function listNames(names) {
  const shown = names.slice(0, LISTED).join(', ');
  return names.length > LISTED ? `${shown} and ${names.length - LISTED} more` : shown;
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 이 행에서 attention 인 필드와 자유 서술 필드, 경고 문구.
 *  - prefix 방식: 이름이 접두어로 시작하는 필드. 그런 필드가 없거나 기대 값이 선택지에 없으면 경고한다
 *  - column 방식: 이 행의 그 컬럼 셀({ 답 이름: 기대 값 })의 키인 필드. 키가 필드에 없거나 기대 값이 그 필드의 선택지에 없으면 경고한다
 *  - 자유 서술: attention 이 아니고 이름이 접미어로 끝나는 필드. type 이 있으면 text 필드와 접미어가 맞는지 경고한다
 * → { attention: Set<name>, freeText: Set<name>, warnings: string[] }
 */
export function checkAnswerFields(schema, settings, row = {}) {
  const byName = new Map(schema.map((field) => [field.name, field]));
  const names = [...byName.keys()];
  const warnings = [];
  let attention = new Set();

  if (settings.attentionEnabled && settings.attentionMode === 'column') {
    const column = settings.attentionColumn;
    const parsed = column ? parseReferenceCell(row?.[column] ?? '') : undefined;
    if (column && isPlainObject(parsed)) {
      const expected = Object.entries(parsed);
      attention = new Set(expected.map(([name]) => name).filter((name) => byName.has(name)));
      const unknown = expected.map(([name]) => name).filter((name) => !byName.has(name));
      if (expected.length === 0) warnings.push(`The "${column}" cell of this row lists no answers, so this HIT has no attention check.`);
      if (unknown.length > 0) warnings.push(`"${column}" expects answers that are not among the fields: ${listNames(unknown)}.`);
      for (const [name, value] of expected) {
        const field = byName.get(name);
        if (!field || field.values.length === 0) continue;
        if (!field.values.includes(String(value))) warnings.push(`The expected value "${value}" of ${name} is not one of its choices (${field.values.join(', ')}).`);
      }
    } else if (column) {
      warnings.push(`The "${column}" cell of this row is not an object of {answer name: expected value}, so this HIT has no attention check.`);
    }
  } else if (settings.attentionEnabled) {
    const prefix = settings.attentionPrefix;
    attention = new Set(names.filter((name) => name.startsWith(prefix)));
    if (attention.size === 0) warnings.push(`No field name starts with "${prefix}". Check the attention rule in Settings.`);
    const expectedMissing = schema.filter((field) => attention.has(field.name) && !field.values.includes(settings.attentionExpected));
    if (expectedMissing.length > 0) {
      warnings.push(`"${settings.attentionExpected}" is not one of the choices of ${expectedMissing[0].name} (${expectedMissing[0].values.join(', ')}).`);
    }
  }

  const suffixes = normalizeSuffixes(settings.freeTextSuffixes ?? []);
  const freeText = new Set(names.filter((name) => !attention.has(name) && suffixes.some((suffix) => name.endsWith(suffix))));
  if (schema.some((field) => typeof field.type === 'string')) {
    const uncovered = schema.filter((field) => field.type === 'text' && !attention.has(field.name) && !freeText.has(field.name)).map((f) => f.name);
    if (uncovered.length > 0) {
      warnings.push(`Text field(s) not matched by the free-text suffixes: ${listNames(uncovered)}. Their text would count as labels in κ and agreement.`);
    }
    const notText = schema.filter((field) => freeText.has(field.name) && field.type !== 'text').map((f) => f.name);
    if (notText.length > 0) {
      warnings.push(`Field(s) ending with a free-text suffix are not text fields: ${listNames(notText)}. They would be left out of κ and agreement.`);
    }
    for (const suffix of suffixes) {
      if (!names.some((name) => name.endsWith(suffix))) warnings.push(`No field name ends with the free-text suffix "${suffix}".`);
    }
  }
  return { attention, freeText, warnings };
}

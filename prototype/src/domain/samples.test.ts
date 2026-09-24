// example/1-task-data의 예시 템플릿과 CSV가 서로 맞는지 확인한다 (5.5). Create의 "Load sample" 버튼이 이 파일을 쓴다.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { extractPlaceholders } from './template';

const read = (name: string) => readFileSync(new URL(`../../../example/1-task-data/${name}`, import.meta.url), 'utf-8');

/** 테스트용 최소 CSV 파서 (RFC 4180: 따옴표 안의 쉼표, 줄바꿈, "" 처리). 앱은 M1에서 PapaParse를 쓴다. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (ch !== '\r') cell += ch;
  }
  if (cell !== '' || row.length > 0) rows.push([...row, cell]);
  return rows;
}

describe('example/1-task-data', () => {
  const html = read('template.html');
  const [header, ...rows] = parseCsv(read('data.csv'));

  it('예시 CSV는 10행이고 모든 행의 컬럼 수가 헤더와 같으며 빈 셀이 없다', () => {
    expect(rows).toHaveLength(10);
    for (const row of rows) {
      expect(row).toHaveLength(header!.length);
      for (const cell of row) expect(cell.trim()).not.toBe('');
    }
  });

  it('예시 템플릿은 TASK_DATA 방식이라 ${...} placeholder가 없다', () => {
    expect(html).toContain('window.TASK_DATA');
    expect(extractPlaceholders(html)).toEqual([]);
  });

  it('템플릿이 읽는 TASK_DATA 키는 전부 CSV 컬럼이다', () => {
    // `data.passage`처럼 코드가 읽는 키만 센다 ("task-data.csv" 같은 파일 이름은 제외)
    const keys = [...new Set([...html.matchAll(/(?<![\w-])data\.([a-z_0-9]+)/g)].map((m) => m[1]!))];
    expect(keys.sort()).toEqual(['attention_sentence', 'passage', 'sentence_1', 'sentence_2']);
    for (const key of keys) expect(header).toContain(key);
  });

  it('응답 규약: input_answers 필드와 attention_ prefix를 쓴다', () => {
    expect(html).toContain('name="input_answers"');
    expect(html).toMatch(/name: 'attention_1'/);
    expect(html).toMatch(/name: 'general_1'/);
  });

  it('예시 템플릿은 100줄 안팎이다', () => {
    const lines = html.split('\n').length;
    expect(lines).toBeGreaterThan(60);
    expect(lines).toBeLessThan(140);
  });
});

// data/ 폴더(scripts/build_fixtures.py의 출력)가 설계 명세 7.1과 맞는지, 그리고 data/ ↔ 상태 변환이 맞는지 확인한다.

import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractPlaceholders } from '../../domain/template';
import { SeedError, assembleState, serializeSeedFile, splitState } from './seedFiles';
import { readSeedFiles } from './seedFromDisk';

const files = readSeedFiles(fileURLToPath(new URL('../../../../data', import.meta.url)));
const NOW = new Date('2026-09-19T00:00:00Z');
// data/에는 attention 판정이 없다. 올릴 때 계산된다.
const fixtures = assembleState(structuredClone(files), NOW);

function statusCounts(batchId: string) {
  const hitIds = new Set(fixtures.hits.filter((h) => h.batchId === batchId).map((h) => h.HITId));
  const counts = { hits: hitIds.size, total: 0, Approved: 0, Rejected: 0, Submitted: 0 };
  for (const a of fixtures.assignments) {
    if (!hitIds.has(a.HITId)) continue;
    counts.total += 1;
    counts[a.AssignmentStatus] += 1;
  }
  return counts;
}

describe('fixture 규모 (7.1의 표)', () => {
  it('F1: 40 HIT, 132 assignment (Approved 108, Rejected 18, Submitted 6), MaxAssignments 3~6, $0.05', () => {
    expect(statusCounts('batch-1000001')).toEqual({
      hits: 40,
      total: 132,
      Approved: 108,
      Rejected: 18,
      Submitted: 6,
    });
    const max = fixtures.hits.filter((h) => h.batchId === 'batch-1000001').map((h) => h.MaxAssignments);
    expect([Math.min(...max), Math.max(...max)]).toEqual([3, 6]);
    expect(fixtures.batches.find((b) => b.id === 'batch-1000001')?.settings.Reward).toBe('0.05');
  });

  it('F2: 16 HIT, 48 assignment (전부 Approved), $0.10', () => {
    expect(statusCounts('batch-1000003')).toEqual({
      hits: 16,
      total: 48,
      Approved: 48,
      Rejected: 0,
      Submitted: 0,
    });
    expect(fixtures.batches.find((b) => b.id === 'batch-1000003')?.settings.Reward).toBe('0.10');
  });

  it('F3: 16 HIT, 51 assignment (Rejected 3), MaxAssignments 3~4, $0.05', () => {
    expect(statusCounts('batch-1000002')).toMatchObject({ hits: 16, total: 51, Rejected: 3 });
    const max = fixtures.hits.filter((h) => h.batchId === 'batch-1000002').map((h) => h.MaxAssignments);
    expect([Math.min(...max), Math.max(...max)]).toEqual([3, 4]);
  });

  it('세 batch를 합치면 worker가 60명', () => {
    expect(new Set(fixtures.assignments.map((a) => a.WorkerId)).size).toBe(60);
  });
});

describe('변환 규칙', () => {
  it('규칙 1: WorkerId는 익명화된 형식이다 ("W" + 16진수 12자리)', () => {
    for (const a of fixtures.assignments) expect(a.WorkerId).toMatch(/^W[0-9a-f]{12}$/);
  });

  it('규칙 2: 모든 assignment는 fixture에 있는 HIT를 가리키고, HIT는 batch를 가리킨다', () => {
    const hitIds = new Set(fixtures.hits.map((h) => h.HITId));
    const batchIds = new Set(fixtures.batches.map((b) => b.id));
    expect(hitIds.size).toBe(fixtures.hits.length);
    for (const a of fixtures.assignments) expect(hitIds.has(a.HITId)).toBe(true);
    for (const h of fixtures.hits) expect(batchIds.has(h.batchId)).toBe(true);
  });

  it('규칙 3: 컬럼은 지우지 않는다. 모든 HIT 입력에 batch의 inputColumns가 다 있다', () => {
    const batchById = new Map(fixtures.batches.map((b) => [b.id, b]));
    for (const hit of fixtures.hits) {
      expect(Object.keys(hit.input)).toEqual(batchById.get(hit.batchId)!.inputColumns);
    }
  });

  it('규칙 3: 템플릿의 placeholder가 전부 입력 컬럼에 있다 (${...} 치환이 실패하지 않는다)', () => {
    for (const batch of fixtures.batches) {
      for (const name of extractPlaceholders(batch.templateHtml)) {
        expect(batch.inputColumns).toContain(name);
      }
    }
  });

  it('규칙 3: HIT 1개의 입력은 64KB를 넘지 않는다 (F2, F3의 무거운 컬럼을 비운 결과)', () => {
    for (const hit of fixtures.hits) {
      const size = Object.values(hit.input).reduce((sum, cell) => sum + cell.length, 0);
      expect(size).toBeLessThan(64 * 1024);
    }
  });

  it('규칙 4: 모든 assignment에 파싱된 응답이 있고, attention 문항이 들어 있다', () => {
    for (const a of fixtures.assignments) {
      expect(a.answers.length).toBeGreaterThan(0);
      expect(a.answers.some((x) => x.name.startsWith('attention_'))).toBe(true);
    }
  });

  it('규칙 5: initialMaxAssignments는 3이고 batch의 목표 라벨 수도 3이다', () => {
    for (const h of fixtures.hits) expect(h.initialMaxAssignments).toBe(3);
    for (const b of fixtures.batches) expect(b.settings.MaxAssignments).toBe(3);
  });

  it('규칙 6: 템플릿은 .html 파일로 있고, placeholder는 올릴 때 뽑는다', () => {
    expect(fixtures.templates.map((t) => t.id).sort()).toEqual(['tpl-chunk-fact-relevance', 'tpl-query-fact-coverage']);
    for (const t of fixtures.templates) {
      expect(t.html).toContain('<crowd-form>');
      expect(t.placeholders).toHaveLength(12);
    }
  });

  it('시각은 ISO 8601 UTC다', () => {
    const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
    for (const h of fixtures.hits) {
      expect(h.CreationTime).toMatch(iso);
      expect(h.Expiration).toMatch(iso);
    }
    for (const a of fixtures.assignments) {
      expect(a.SubmitTime).toMatch(iso);
      const worked = (Date.parse(a.SubmitTime) - Date.parse(a.AcceptTime)) / 1000;
      expect(worked).toBe(a.workTimeInSeconds);
    }
  });
});

describe('assembleState', () => {
  const state = fixtures;

  it('모든 assignment에 attention 판정을 붙인다', () => {
    expect(state.assignments).toHaveLength(231);
    for (const a of state.assignments) expect(a.attention).not.toBeNull();
  });

  // 케이스 스터디의 실제 검수 결과는 "attention 전부 정답" 기준과 일치하지 않는다 (명세 12장 미결정 사항 5).
  // F1의 반려 18건은 사유가 전부 "Failed to pass the attention check task."인데 그중 7건은 attention을 다 맞혔고,
  // 반대로 attention을 틀렸는데 Approved된 건이 14건 있다. Review 화면(M2)은 이 불일치가 있는 데이터를 다뤄야 한다.
  it('F1의 검수 상태와 attention 판정의 분포 (판정은 실제 검수 결과와 일치하지 않는다)', () => {
    const f1Hits = new Set(state.hits.filter((h) => h.batchId === 'batch-1000001').map((h) => h.HITId));
    const table: Record<string, number> = {};
    for (const a of state.assignments) {
      if (!f1Hits.has(a.HITId)) continue;
      const key = `${a.AssignmentStatus}/${a.attention?.passed ? 'pass' : 'fail'}`;
      table[key] = (table[key] ?? 0) + 1;
    }
    expect(table).toEqual({
      'Approved/pass': 94,
      'Approved/fail': 14,
      'Rejected/fail': 11,
      'Rejected/pass': 7,
      'Submitted/pass': 6,
    });
  });

  it('기본 pool 두 개와 mock 계정으로 시작한다', () => {
    expect(state.pools.map((p) => p.name)).toEqual(['Trusted', 'Excluded']);
    expect(state.account).toEqual({ env: 'mock', AvailableBalance: '500.00' });
    expect(state.savedAt).toBeNull();
  });

  it('batch의 템플릿 사본은 같은 폴더의 template.html에서 온다', () => {
    for (const batch of state.batches) {
      expect(batch.templateHtml).toBe(files[`batches/${batch.id}/template.html`]);
    }
  });

  it('data/를 손으로 고치다 생기는 실수를 파일 이름과 함께 알려준다', () => {
    const broken = structuredClone(files);
    (broken['batches/batch-1000001/assignments.json'] as { HITId: string }[])[0]!.HITId = 'NO_SUCH_HIT';
    expect(() => assembleState(broken, NOW)).toThrow(SeedError);
    expect(() => assembleState(broken, NOW)).toThrow(/data\/batches\/batch-1000001\/assignments\.json: .*NO_SUCH_HIT/);

    const missingHtml = structuredClone(files);
    delete missingHtml['templates/chunk-fact-relevance.html'];
    expect(() => assembleState(missingHtml, NOW)).toThrow(/data\/templates\/chunk-fact-relevance\.html: file is missing/);
  });
});

describe('splitState (상태 → data/ 구조)', () => {
  it('data/ → 상태 → data/ → 상태로 한 바퀴 돌려도 같은 상태가 된다', () => {
    const again = assembleState(splitState(fixtures), NOW);
    expect(again).toEqual(fixtures);
  });

  it('data/에 쓰는 파일에는 attention 판정과 템플릿 사본 문자열을 넣지 않는다', () => {
    const out = splitState(fixtures);
    const assignments = out['batches/batch-1000001/assignments.json'] as Record<string, unknown>[];
    expect(assignments[0]).not.toHaveProperty('attention');
    expect(out['batches/batch-1000001/batch.json']).not.toHaveProperty('templateHtml');
    expect(typeof out['batches/batch-1000001/template.html']).toBe('string');
  });

  it('큰 목록은 레코드 하나를 한 줄에 쓴다 (build_fixtures.py와 같은 표기)', () => {
    const text = serializeSeedFile('batches/x/assignments.json', [{ a: 1 }, { a: 2 }]);
    expect(text).toBe('[\n{"a":1},\n{"a":2}\n]\n');
    expect(serializeSeedFile('pools.json', [{ id: 'p' }])).toContain('\n  {\n');
    expect(serializeSeedFile('templates/t.html', '<p>x</p>')).toBe('<p>x</p>');
  });
});

// data/ 폴더(JSON + HTML)와 mock 저장소의 상태를 서로 바꾸는 순수 함수. 구조는 data/README.md에 있다.
// 파일을 어떻게 읽는지(브라우저: 번들, 서버와 테스트: 디스크)는 seedFromBundle.ts와 seedFromDisk.ts가 맡는다.

import { judgeAttention } from '../../domain/attention';
import { extractPlaceholders } from '../../domain/template';
import type { Account, Assignment, Batch, Hit, Template, WorkerPool } from '../types';
import { SNAPSHOT_VERSION, type StoreState } from './store';

/** data/ 기준 상대 경로 → 내용. `.json`은 파싱된 값, `.html`은 문자열이다. */
export type SeedFiles = Record<string, unknown>;

export interface TemplateIndexEntry {
  id: string;
  name: string;
  file: string; // templates/ 안의 .html 파일 이름
  updatedAt: string;
}

/** data/의 batch.json. 템플릿 사본은 같은 폴더의 template.html에 있다. */
export type BatchFile = Omit<Batch, 'templateHtml'>;
/** data/의 assignments.json. attention 판정은 올릴 때 batch의 attentionRule로 계산한다. */
export type AssignmentFile = Omit<Assignment, 'attention'> & { attention?: unknown };

export const DEFAULT_ACCOUNT: Account = { env: 'mock', AvailableBalance: '500.00' };

export class SeedError extends Error {
  constructor(file: string, problem: string) {
    super(`data/${file}: ${problem}`);
    this.name = 'SeedError';
  }
}

function requireArray<T>(files: SeedFiles, path: string): T[] {
  const value = files[path];
  if (!Array.isArray(value)) throw new SeedError(path, 'expected a JSON array');
  return value as T[];
}

function requireHtml(files: SeedFiles, path: string): string {
  const value = files[path];
  if (typeof value !== 'string') throw new SeedError(path, 'file is missing');
  return value;
}

export function assembleState(files: SeedFiles, now: Date = new Date()): StoreState {
  const templates: Template[] = requireArray<TemplateIndexEntry>(files, 'templates/index.json').map((entry) => {
    const html = requireHtml(files, `templates/${entry.file}`);
    return {
      id: entry.id,
      name: entry.name,
      html,
      placeholders: extractPlaceholders(html),
      updatedAt: entry.updatedAt,
    };
  });

  const batchIds = Object.keys(files)
    .map((path) => /^batches\/([^/]+)\/batch\.json$/.exec(path)?.[1])
    .filter((id): id is string => id !== undefined)
    .sort();

  const batches: Batch[] = [];
  const hits: Hit[] = [];
  const assignments: Assignment[] = [];
  const seenHits = new Set<string>();
  const seenAssignments = new Set<string>();

  for (const folder of batchIds) {
    const dir = `batches/${folder}`;
    const batchFile = files[`${dir}/batch.json`] as BatchFile;
    if (batchFile.id !== folder) {
      throw new SeedError(`${dir}/batch.json`, `"id" is ${JSON.stringify(batchFile.id)} but the folder is "${folder}"`);
    }
    batches.push({ ...batchFile, templateHtml: requireHtml(files, `${dir}/template.html`) });

    const hitIdsHere = new Set<string>();
    for (const hit of requireArray<Hit>(files, `${dir}/hits.json`)) {
      if (hit.batchId !== folder) {
        throw new SeedError(`${dir}/hits.json`, `HIT ${hit.HITId} has batchId ${JSON.stringify(hit.batchId)}`);
      }
      if (seenHits.has(hit.HITId)) throw new SeedError(`${dir}/hits.json`, `duplicate HITId ${hit.HITId}`);
      seenHits.add(hit.HITId);
      hitIdsHere.add(hit.HITId);
      hits.push(hit);
    }

    for (const a of requireArray<AssignmentFile>(files, `${dir}/assignments.json`)) {
      if (!hitIdsHere.has(a.HITId)) {
        throw new SeedError(`${dir}/assignments.json`, `assignment ${a.AssignmentId} points to unknown HIT ${a.HITId}`);
      }
      if (seenAssignments.has(a.AssignmentId)) {
        throw new SeedError(`${dir}/assignments.json`, `duplicate AssignmentId ${a.AssignmentId}`);
      }
      seenAssignments.add(a.AssignmentId);
      assignments.push({ ...a, attention: judgeAttention(a.answers, batchFile.attentionRule) });
    }
  }

  return {
    version: SNAPSHOT_VERSION,
    seededAt: now.toISOString(),
    savedAt: null,
    templates,
    batches,
    hits,
    assignments,
    pools: files['pools.json'] === undefined ? [] : requireArray<WorkerPool>(files, 'pools.json'),
    workerMeta: (files['workers.json'] as StoreState['workerMeta'] | undefined) ?? {},
    account: (files['account.json'] as Account | undefined) ?? DEFAULT_ACCOUNT,
  };
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'template';
}

/** assembleState의 역변환. 콘솔에서 만든 상태를 data/ 구조로 되돌려 다음 시작점으로 쓸 수 있게 한다. */
export function splitState(state: StoreState): SeedFiles {
  const files: SeedFiles = {
    'account.json': state.account,
    'pools.json': state.pools,
    'workers.json': state.workerMeta,
  };

  const usedNames = new Set<string>();
  const index: TemplateIndexEntry[] = state.templates.map((t) => {
    let file = `${slug(t.id.replace(/^tpl-/, ''))}.html`;
    for (let n = 2; usedNames.has(file); n += 1) file = `${slug(t.id.replace(/^tpl-/, ''))}-${n}.html`;
    usedNames.add(file);
    files[`templates/${file}`] = t.html;
    return { id: t.id, name: t.name, file, updatedAt: t.updatedAt };
  });
  files['templates/index.json'] = index;

  const hitBatch = new Map(state.hits.map((h) => [h.HITId, h.batchId]));
  for (const batch of state.batches) {
    const dir = `batches/${batch.id}`;
    const { templateHtml, ...batchFile } = batch;
    files[`${dir}/batch.json`] = batchFile;
    files[`${dir}/template.html`] = templateHtml;
    files[`${dir}/hits.json`] = state.hits.filter((h) => h.batchId === batch.id);
    files[`${dir}/assignments.json`] = state.assignments
      .filter((a) => hitBatch.get(a.HITId) === batch.id)
      .map(({ attention: _recomputed, ...rest }) => rest);
  }
  return files;
}

/** 큰 목록(hits.json, assignments.json)은 레코드 하나를 한 줄에 쓴다. build_fixtures.py와 같은 표기다. */
export function serializeSeedFile(path: string, content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content) && /\/(hits|assignments)\.json$/.test(path)) {
    return `[\n${content.map((record) => JSON.stringify(record)).join(',\n')}\n]\n`;
  }
  return `${JSON.stringify(content, null, 2)}\n`;
}

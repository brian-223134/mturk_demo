// data/ 폴더를 디스크에서 읽고 쓴다. Node 전용이다 (mock API 서버, 테스트, scripts). 브라우저 번들에 넣지 않는다.

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { serializeSeedFile, type SeedFiles } from './seedFiles';

export function readSeedFiles(dataDir: string): SeedFiles {
  const files: SeedFiles = {};
  const entries = readdirSync(dataDir, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const full = join(entry.parentPath, entry.name);
    const path = relative(dataDir, full).split(sep).join('/');
    if (path.endsWith('.json')) {
      try {
        files[path] = JSON.parse(readFileSync(full, 'utf-8'));
      } catch (error) {
        throw new Error(`data/${path}: invalid JSON (${(error as Error).message})`);
      }
    } else if (path.endsWith('.html')) {
      files[path] = readFileSync(full, 'utf-8');
    }
  }
  return files;
}

/** templates/와 batches/를 비우고 다시 쓴다. README.md 같은 다른 파일은 건드리지 않는다. */
export function writeSeedFiles(dataDir: string, files: SeedFiles): void {
  for (const folder of ['templates', 'batches']) rmSync(join(dataDir, folder), { recursive: true, force: true });
  for (const [path, content] of Object.entries(files)) {
    const full = join(dataDir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, serializeSeedFile(path, content), 'utf-8');
  }
}

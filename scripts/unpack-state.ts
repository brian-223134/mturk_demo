// 콘솔의 "Export data (JSON)"으로 받은 파일을 data/ 폴더 구조로 푼다. 콘솔에서 만든 상태를 다음 시작점으로 삼을 때 쓴다.
//
//   npm run data:unpack -- <내려받은 파일>.json [data]
//
// data/templates와 data/batches를 지우고 다시 쓴다. 적용하려면 콘솔에서 Mock tools → Reset to fixtures를 누른다.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { splitState } from '../src/api/mock/seedFiles';
import { writeSeedFiles } from '../src/api/mock/seedFromDisk';
import { parseStateFile } from '../src/api/mock/tools';

const [source, target = 'data'] = process.argv.slice(2);
if (!source) {
  console.error('usage: npm run data:unpack -- <exported.json> [data dir]');
  process.exit(1);
}
const state = parseStateFile(readFileSync(resolve(source), 'utf-8'));
const files = splitState(state);
writeSeedFiles(resolve(target), files);
console.log(`${Object.keys(files).length} files written to ${resolve(target)}`);
console.log(`  ${state.templates.length} templates, ${state.batches.length} batches, ${state.hits.length} HITs, ${state.assignments.length} assignments, ${state.pools.length} pools`);

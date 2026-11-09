// 두 실험 러너(run.mjs: binding 정답지, run-free.mjs: 자유 계약)가 같이 쓰는 것: HTML Agent 에게 보낼 요청, Python Agent 호출, 렌더 오류 묶기.

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const ROOT = resolve(import.meta.dirname, '../..');
export const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

/** HTML Agent 에게 보낼 요청 (콘솔 화면과 같은 함수). */
export { pageRequest as buildRequest } from '../../frontend/src/lib/html-harness.js';

/** 행마다의 렌더 오류를 같은 문구끼리 묶는다: "HIT 1, 2, 5: …". */
export function groupRowErrors(errors) {
  const byMessage = new Map();
  for (const { row, message } of errors) byMessage.set(message, [...(byMessage.get(message) ?? []), row + 1]);
  return [...byMessage].map(([message, rows]) => `HIT ${rows.slice(0, 5).join(', ')}${rows.length > 5 ? ` and ${rows.length - 5} more` : ''}: ${message}`);
}

/** python3 -m <module> 으로 Agent 를 부르는 send 함수. 호출마다 요청·응답·로그를 dir 에 <prefix>-<n> 으로 남긴다. */
export function pythonSender({ module, dir, prefix, allowApi, python = 'python3', modelConfig }) {
  let call = 0;
  return async (body) => {
    call += 1;
    const requestFile = join(dir, `${prefix}request-${call}.json`);
    const replyFile = join(dir, `${prefix}reply-${call}.json`);
    writeFileSync(requestFile, JSON.stringify(body, null, 2));
    const command = ['-m', module, requestFile, '--out', replyFile, '--log-dir', join(dir, `${prefix}log-${call}`)];
    if (allowApi) command.push('--allow-api');
    if (modelConfig) command.push('--model-config', modelConfig);
    const run = spawnSync(python, command, { cwd: ROOT, encoding: 'utf8', env: process.env });
    let reply;
    try {
      reply = JSON.parse(readFileSync(replyFile, 'utf8'));
    } catch {
      throw new Error(`The agent wrote no reply (exit ${run.status}): ${run.stderr.trim().slice(-400)}`);
    }
    if (reply.error) throw new Error(`The agent call failed: ${reply.error}`);
    return reply;
  };
}

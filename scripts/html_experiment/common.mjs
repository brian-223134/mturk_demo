// 두 실험 러너(run.mjs: binding 정답지, run-free.mjs: 자유 계약)가 같이 쓰는 것: HTML Agent 에게 보낼 요청, Python Agent 호출, 렌더 오류 묶기.

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { layoutNotes, layoutRequest, layoutSummary } from '../../frontend/src/lib/layout-check.js';

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

/**
 * 배치 판정(agent.layout_judge)을 부르는 review 함수. render(html) 은 첫 HIT 를 그려 측정값을 돌려준다.
 * → review(html) → { notes, checks, usage }. 판정마다 요청·응답을 dir 에 <prefix>request-<n>.json 으로 남긴다.
 */
export function layoutReviewer({ dir, prefix, requestText, render, allowApi, python, modelConfig, fixed = [] }) {
  const send = pythonSender({ module: 'agent.layout_judge', dir, prefix, allowApi, python, modelConfig });
  return async (html) => {
    const page = render(html);
    if (!page) return { notes: [], checks: [], usage: null };
    const reply = await send(layoutRequest(requestText, page, fixed));
    return { notes: layoutNotes(reply.checks), checks: reply.checks ?? [], usage: reply.usage };
  };
}

/** 판정 결과의 짧은 글: "met 3 / not_met 1 / unclear 0". */
export function checksText(checks) {
  if (!checks) return '-';
  const counts = layoutSummary(checks);
  return `met ${counts.met} / not ${counts.not_met} / ? ${counts.unclear}`;
}

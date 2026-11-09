// Agent 가 task 페이지 HTML 을 직접 쓰는 실험의 러너.
// 시나리오(scenarios.json)마다 binding 으로 정답지 템플릿과 계약을 만들고, Agent 에게 요청대로 페이지를 다시 쓰게 한 뒤
// harness(frontend/src/lib/html-harness.js)의 정적 검사와 Chrome 렌더 검사를 돌린다. 실패하면 오류를 붙여 다시 묻는다.
//
//   node scripts/html_experiment/run.mjs --writer reference            정답지를 그대로 내는 가짜 Agent (harness 자체 점검, 무료)
//   node scripts/html_experiment/run.mjs --writer agent --allow-api    실제 LLM 호출 (유료)
//   옵션: --only a,b  --out DIR  --no-render  --max-attempts 3  --python python3  --model-config NAME
//         --judge  그려진 페이지를 요청과 대조(agent.layout_judge, 유료). 맞지 않으면 다시 묻고, 기본 페이지도 같은 요청으로 판정해 비교한다
// 결과는 var/html-experiment/<시각>/ 에 남는다 (git 에 넣지 않는다): 시나리오별 시도마다의 HTML, 요청, 응답, 화면 사진, results.json, summary.md.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { dataReader } from '../../frontend/src/lib/design-binding.js';
import { checkAgentHtml, compareRendered, contractFor, requestHtml } from '../../frontend/src/lib/html-harness.js';
import { parseJsonData } from '../../frontend/src/lib/json-data.js';
import { ROOT, buildRequest, checksText, groupRowErrors, layoutReviewer, pythonSender, stamp } from './common.mjs';
import { findChrome, renderPages, screenshot } from './render.mjs';

const { values: args } = parseArgs({
  options: {
    writer: { type: 'string', default: 'reference' },
    'allow-api': { type: 'boolean', default: false },
    only: { type: 'string' },
    out: { type: 'string' },
    'no-render': { type: 'boolean', default: false },
    'max-attempts': { type: 'string', default: '3' },
    python: { type: 'string', default: 'python3' },
    'model-config': { type: 'string' },
    judge: { type: 'boolean', default: false },
  },
});

const read = (path) => readFileSync(join(ROOT, path), 'utf8');

async function runScenario(scenario, outRoot, chrome) {
  const dir = join(outRoot, scenario.name);
  mkdirSync(dir, { recursive: true });
  const binding = JSON.parse(read(scenario.binding));
  const contract = contractFor(binding, dataReader(parseJsonData(read(scenario.data), scenario.data)));
  const rows = contract.data.rows;
  writeFileSync(join(dir, 'reference.html'), contract.html);

  let reference = null;
  if (chrome) {
    reference = renderPages({ html: contract.html, rows, chrome, workDir: dir, name: 'reference' });
    const self = compareRendered(contract, reference, reference).errors;
    if (self.length > 0) throw new Error(`The reference template fails its own render check: ${groupRowErrors(self).join(' ')}`);
  }

  let attempt = 0;
  const layouts = new Map(); // html → 첫 HIT 의 측정값
  if (reference) layouts.set(contract.html, reference[0]?.layout ?? null);
  const check = async (html) => {
    attempt += 1;
    writeFileSync(join(dir, `attempt-${attempt}.html`), html ?? '');
    const result = checkAgentHtml(html, contract);
    if (result.errors.length > 0 || !chrome) return result;
    const rendered = renderPages({ html, rows, chrome, workDir: dir, name: `attempt-${attempt}` });
    layouts.set(html, rendered[0]?.layout ?? null);
    return { errors: groupRowErrors(compareRendered(contract, reference, rendered).errors), warnings: result.warnings };
  };
  const judging = args.judge && chrome && args.writer === 'agent';
  const review = judging ? layoutReviewer({ dir, prefix: 'judge-', requestText: scenario.request, render: (html) => layouts.get(html), allowApi: args['allow-api'], python: args.python, modelConfig: args['model-config'] }) : undefined;
  const send = args.writer === 'agent' ? pythonSender({ module: 'agent.html_writer', dir, prefix: '', allowApi: args['allow-api'], python: args.python, modelConfig: args['model-config'] }) : async () => ({ html: contract.html, message: 'Returned the current template unchanged.' });

  const started = Date.now();
  const result = await requestHtml({ send, check, review, request: buildRequest(contract, scenario.request, binding.task_type), maxAttempts: Number(args['max-attempts']) });
  const templateReview = judging ? await layoutReviewer({ dir, prefix: 'judge-template-', requestText: scenario.request, render: (html) => layouts.get(html), allowApi: args['allow-api'], python: args.python, modelConfig: args['model-config'] })(contract.html) : null;
  const seconds = Math.round((Date.now() - started) / 100) / 10;
  const outcome = result.cannot ? 'cannot' : result.errors.length === 0 ? 'pass' : 'fail';
  const success = scenario.expect === 'refuse' ? outcome !== 'fail' : outcome === 'pass';

  if (outcome === 'pass' && chrome) {
    screenshot({ html: result.html, row: rows[0], chrome, workDir: dir, file: 'final-wide', width: 1100 });
    screenshot({ html: result.html, row: rows[0], chrome, workDir: dir, file: 'final-phone', width: 420, height: 1600 });
  }
  return {
    name: scenario.name,
    kind: scenario.kind,
    expect: scenario.expect,
    outcome,
    success,
    attempts: result.attempts,
    first_pass: result.history[0]?.errors.length === 0 && !result.history[0]?.cannot,
    errors_by_attempt: result.history.map(({ attempt: n, errors, notes, cannot }) => ({ attempt: n, cannot: cannot ?? null, errors, notes: notes ?? [] })),
    message: result.message,
    layout_checks: judging ? result.checks : null,
    template_layout_checks: templateReview?.checks ?? null,
    cost: (result.usage.cost ?? 0) + (templateReview?.usage?.cost ?? 0) || null,
    calls: result.usage.calls,
    seconds,
    hits: rows.length,
  };
}

function summary(results, meta) {
  const lines = [
    `# HTML 작성 실험 결과`,
    '',
    `- 시각: ${meta.started}`,
    `- writer: ${meta.writer}${meta.writer === 'agent' ? ` (${meta.model ?? 'default model'})` : ''}`,
    `- 렌더 검사: ${meta.render ? '했음 (Chrome)' : '하지 않음'}`,
    `- 성공 ${results.filter((r) => r.success).length} / ${results.length}, 첫 시도 통과 ${results.filter((r) => r.first_pass).length}, 비용 합계 $${results.reduce((sum, r) => sum + (r.cost ?? 0), 0).toFixed(4)}`,
    '',
    '| 시나리오 | 종류 | 기대 | 결과 | 시도 | 배치 판정(최종) | 배치 판정(기본 페이지) | 비용 | 시간(초) | 마지막 오류 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const r of results) {
    const last = r.errors_by_attempt.at(-1)?.errors ?? [r.error].filter(Boolean);
    lines.push(`| ${r.name} | ${r.kind} | ${r.expect} | ${r.success ? '성공' : '실패'} (${r.outcome}) | ${r.attempts ?? '-'} | ${checksText(r.layout_checks)} | ${checksText(r.template_layout_checks)} | ${r.cost === null || r.cost === undefined ? '-' : `$${r.cost.toFixed(4)}`} | ${r.seconds ?? '-'} | ${last.length ? last.join('<br>').replace(/\|/g, '\\|') : ''} |`);
  }
  if (results.some((r) => r.layout_checks)) {
    lines.push('', '## 배치 판정', '');
    for (const r of results) {
      for (const [title, checks] of [['최종', r.layout_checks], ['기본 페이지', r.template_layout_checks]]) {
        for (const check of checks ?? []) lines.push(`- **${r.name}** (${title}) ${check.result}: ${check.wish} — ${check.evidence}`);
      }
    }
  }
  lines.push('', '## Agent 의 설명(message)', '');
  for (const r of results) lines.push(`- **${r.name}**: ${r.message ?? '(없음)'}`);
  return `${lines.join('\n')}\n`;
}

const scenarios = JSON.parse(read('scripts/html_experiment/scenarios.json')).filter((s) => !args.only || args.only.split(',').includes(s.name));
const outRoot = resolve(args.out ?? join(ROOT, 'var/html-experiment', `${stamp()}-${args.writer}`));
const chrome = args['no-render'] ? null : findChrome();
if (!args['no-render'] && !chrome) console.warn('Chrome을 찾지 못해 렌더 검사 없이 진행합니다. CHROME 환경변수로 경로를 줄 수 있습니다.');
if (args.writer === 'agent' && !args['allow-api']) console.warn('--allow-api 가 없으므로 Agent 호출은 실제 요청 직전에 멈춥니다.');
mkdirSync(outRoot, { recursive: true });

const started = new Date().toISOString();
const results = [];
for (const scenario of scenarios) {
  process.stdout.write(`${scenario.name} … `);
  try {
    const result = await runScenario(scenario, outRoot, chrome);
    results.push(result);
    console.log(`${result.success ? 'OK' : 'FAIL'} (${result.outcome}, ${result.attempts}회${result.cost ? `, $${result.cost.toFixed(4)}` : ''})`);
  } catch (error) {
    results.push({ name: scenario.name, kind: scenario.kind, expect: scenario.expect, outcome: 'error', success: false, error: error.message, errors_by_attempt: [] });
    console.log(`ERROR ${error.message}`);
  }
}
const meta = { started, writer: args.writer, model: args['model-config'], render: Boolean(chrome) };
writeFileSync(join(outRoot, 'results.json'), JSON.stringify({ meta, results }, null, 2));
writeFileSync(join(outRoot, 'summary.md'), summary(results, meta));
console.log(`\n결과: ${outRoot}`);

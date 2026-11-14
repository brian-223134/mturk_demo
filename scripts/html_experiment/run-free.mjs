// 자유 계약 실험의 러너: Requester 의 prompt 하나(또는 Draft with AI 처럼 한 줄 목표)로 가안 없이 HIT 페이지를 만든다.
//   1. 계약 Agent(agent.contract_writer): prompt 나 goal + 데이터 요약 + 단위 후보 → 계약(단위, 값, 문항 몇 개든, 문항별 대조 기준·attention,
//      페이지 문장). checkDesign 으로 단위대로 HIT 표를 만들어 검사, 최대 3번. goal 시나리오는 unit 이 있어야 한다
//   2. 코드: 계약 → 기본 템플릿(정답지)과 게시용 행 (lib/task-unit.js, lib/task-contract.js)
//   3. HTML Agent(agent.html_writer): 계약의 페이지 문장(layout, 없으면 prompt)대로 페이지를 쓴다. html-harness 의 정적 검사와 Chrome 렌더 검사, 최대 3번
// 시나리오의 expect(단위, HIT 수, 문항 종류와 수, 대조 기준·attention 유무, 한 번만·항목마다 보일 값, 보이면 안 되는 컬럼, 탭 없음)도 코드로 확인한다.
//
//   node scripts/html_experiment/run-free.mjs --writer reference           fixture 계약과 기본 템플릿으로 흐름만 점검 (호출 없음)
//   node scripts/html_experiment/run-free.mjs --writer agent --allow-api   실제 LLM 호출 (유료)
//   옵션: --only a,b  --out DIR  --no-render  --max-attempts 3  --python python3  --model-config NAME
//         --judge  그려진 페이지를 요청과 대조(agent.layout_judge, 유료). 맞지 않으면 다시 묻고, 기본 페이지도 같은 요청으로 판정해 비교한다

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { dataReader, parsePath, summarizeData } from '../../frontend/src/lib/design-binding.js';
import { checkAgentHtml, compareRendered, requestHtml } from '../../frontend/src/lib/html-harness.js';
import { parseRecordsJson } from '../../frontend/src/lib/json-records.js';
import { fixedFromOutline } from '../../frontend/src/lib/layout-check.js';
import { contractOutline, harnessContract, layoutText, requestContract } from '../../frontend/src/lib/task-contract.js';
import { checkDesign, unitOptions } from '../../frontend/src/lib/task-unit.js';
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
const addCost = (...usages) => usages.reduce((sum, usage) => sum + (usage?.cost ?? 0), 0);

/** 계약과 최종 HTML 이 시나리오의 기대와 다른 점들. hits 는 단위대로 만든 HIT 수다. */
export function expectationFailures(contract, html, expect = {}, hits = null) {
  const failures = [];
  const unit = contract?.unit ?? {};
  if (expect.unit && !(Array.isArray(expect.unit) ? expect.unit : [expect.unit]).includes(unit.level)) failures.push(`단위 ${[expect.unit].flat().join(' 또는 ')} 를 기대했으나 ${unit.level ?? '없음'}`);
  if (expect.group_by !== undefined && unit.group_by !== expect.group_by) failures.push(`group_by ${expect.group_by} 를 기대했으나 ${unit.group_by ?? '없음'}`);
  if (expect.split_by !== undefined && unit.split?.by !== expect.split_by) failures.push(`split ${expect.split_by} 를 기대했으나 ${unit.split?.by ?? '없음'}`);
  if (expect.frame_at && !(contract?.fields ?? []).some((field) => field.kind === 'video' && field.at)) failures.push('영상 값에 frame 시각(at)이 없음');
  if (expect.hits && hits !== null && (hits < expect.hits[0] || hits > expect.hits[1])) failures.push(`HIT ${expect.hits[0]}~${expect.hits[1]}개를 기대했으나 ${hits}개`);
  const questions = contract?.questions ?? [];
  const fields = contract?.fields ?? [];
  if (expect.types) {
    const counts = {};
    for (const question of questions) counts[question.type] = (counts[question.type] ?? 0) + 1;
    for (const [type, count] of Object.entries(expect.types)) if ((counts[type] ?? 0) !== count) failures.push(`${type} 문항 ${count}개를 기대했으나 ${counts[type] ?? 0}개`);
    const extra = Object.keys(counts).filter((type) => !(type in expect.types));
    if (extra.length > 0) failures.push(`기대하지 않은 문항 종류: ${extra.join(', ')}`);
  }
  const hasReference = (Array.isArray(contract?.reference) ? contract.reference : contract?.reference ? [contract.reference] : []).length > 0;
  if (expect.reference !== undefined && hasReference !== expect.reference) failures.push(expect.reference ? '대조 기준이 없음' : '대조 기준이 생김');
  if (expect.attention !== undefined && Boolean(contract?.attention) !== expect.attention) failures.push(expect.attention ? 'attention 이 없음' : 'attention 이 생김');
  const shownColumns = [...fields.map((f) => f.from), ...questions.filter((q) => typeof q.items === 'string').map((q) => q.items)].map((path) => parsePath(path)?.column);
  for (const column of expect.hidden ?? []) if (shownColumns.includes(column)) failures.push(`정답 컬럼 ${column} 이 화면 값으로 쓰임`);
  for (const column of expect.once ?? []) {
    const field = fields.find((f) => parsePath(f.from)?.column === column);
    if (!field) failures.push(`${column} 이 화면에 없음`);
    else if (parsePath(field.from).steps.some((step) => step.index === 'i')) failures.push(`${column} 이 한 번이 아니라 항목마다 보임`);
  }
  for (const column of expect.per_item ?? []) {
    const field = fields.find((f) => parsePath(f.from)?.column === column);
    if (!field) failures.push(`${column} 이 화면에 없음`);
    else if (!parsePath(field.from).steps.some((step) => step.index === 'i')) failures.push(`${column} 이 항목마다가 아니라 한 번만 보임 (데이터상 항목마다 다름)`);
  }
  if (expect.no_tabs && html && /<ann-tabs\b/i.test(html)) failures.push('탭이 남아 있음');
  return failures;
}

function taskTypeOf(contract) {
  const kinds = (contract.fields ?? []).map((field) => field.kind ?? 'text');
  return kinds.includes('video') ? 'video' : kinds.includes('image') ? 'vision' : 'text';
}

async function runScenario(scenario, outRoot, chrome) {
  const dir = join(outRoot, scenario.name);
  mkdirSync(dir, { recursive: true });
  const data = parseRecordsJson(read(scenario.data), scenario.data);
  const reader = dataReader(data);
  const drafting = scenario.goal !== undefined; // Draft with AI: 한 줄 목표만 준다
  const checkOf = (contract) => checkDesign(contract, data, { requireUnit: drafting });
  const maxAttempts = Number(args['max-attempts']);
  const agent = args.writer === 'agent';
  const started = Date.now();

  // 1. 계약
  let contractResult;
  if (agent) {
    const send = pythonSender({ module: 'agent.contract_writer', dir, prefix: 'contract-', allowApi: args['allow-api'], python: args.python, modelConfig: args['model-config'] });
    const ask = drafting ? { goal: scenario.goal } : { request: scenario.request };
    contractResult = await requestContract({ send, check: checkOf, request: { ...ask, data: summarizeData(reader), units: unitOptions(reader) }, maxAttempts });
  } else {
    if (!scenario.fixture) return { name: scenario.name, kind: scenario.kind, outcome: 'skipped', success: true, note: 'fixture 가 없어 reference 실행에서 건너뜀' };
    const contract = JSON.parse(read(scenario.fixture));
    contractResult = { contract, message: null, cannot: null, errors: checkOf(contract).errors, attempts: 0, usage: { calls: 0 }, history: [] };
  }
  writeFileSync(join(dir, 'contract.json'), JSON.stringify(contractResult.contract, null, 2));
  const base = {
    name: scenario.name,
    kind: scenario.kind,
    contract_attempts: contractResult.attempts,
    contract_errors_by_attempt: contractResult.history.map(({ attempt, errors, cannot }) => ({ attempt, cannot: cannot ?? null, errors })),
    contract_message: contractResult.message,
  };
  if (contractResult.cannot || contractResult.errors.length > 0) {
    const outcome = contractResult.cannot ? 'cannot' : 'contract-fail';
    return { ...base, outcome, success: scenario.kind === 'trap' && outcome === 'cannot', expectation_failures: [], cost: addCost(contractResult.usage), seconds: (Date.now() - started) / 1000 };
  }

  // 2. 정답지 (단위대로 만든 HIT 표로)
  const contract = harnessContract(contractResult.contract, checkOf(contractResult.contract).reader);
  const rows = contract.data.rows;
  const wish = layoutText(contractResult.contract) || scenario.request || ''; // 콘솔처럼 계약의 페이지 문장으로 다시 쓴다
  writeFileSync(join(dir, 'template.html'), contract.html);
  let reference = null;
  if (chrome) {
    reference = renderPages({ html: contract.html, rows, chrome, workDir: dir, name: 'template' });
    const self = compareRendered(contract, reference, reference).errors;
    if (self.length > 0) throw new Error(`The contract template fails its own render check: ${groupRowErrors(self).join(' ')}`);
    screenshot({ html: contract.html, row: rows[0], chrome, workDir: dir, file: 'template-wide', width: 1100 });
  }

  // 3. HTML
  let attempt = 0;
  const layouts = new Map(); // html → 첫 HIT 의 측정값
  if (reference) layouts.set(contract.html, reference[0]?.layout ?? null);
  const check = async (html) => {
    attempt += 1;
    writeFileSync(join(dir, `html-attempt-${attempt}.html`), html ?? '');
    const result = checkAgentHtml(html, contract);
    if (result.errors.length > 0 || !chrome) return result;
    const rendered = renderPages({ html, rows, chrome, workDir: dir, name: `html-attempt-${attempt}` });
    layouts.set(html, rendered[0]?.layout ?? null);
    return { errors: groupRowErrors(compareRendered(contract, reference, rendered).errors), warnings: result.warnings };
  };
  const judging = args.judge && chrome && agent;
  const reviewer = (prefix) => layoutReviewer({ dir, prefix, requestText: wish, render: (html) => layouts.get(html), allowApi: args['allow-api'], python: args.python, modelConfig: args['model-config'], fixed: fixedFromOutline(contractOutline(contractResult.contract)) });
  const review = judging && wish ? reviewer('judge-') : undefined;
  const send = agent
    ? pythonSender({ module: 'agent.html_writer', dir, prefix: 'html-', allowApi: args['allow-api'], python: args.python, modelConfig: args['model-config'] })
    : async () => ({ html: contract.html, message: 'Used the contract template unchanged.' });
  // 페이지 문장이 없으면 기본 페이지를 그대로 쓴다 (콘솔과 같음)
  const htmlResult = wish
    ? await requestHtml({ send, check, review, request: buildRequest(contract, wish, taskTypeOf(contractResult.contract)), maxAttempts })
    : { html: contract.html, message: 'No page wishes: the plain layout.', cannot: null, errors: (await check(contract.html)).errors, notes: [], checks: [], attempts: 0, usage: { calls: 0 }, history: [] };
  const templateReview = judging && wish ? await reviewer('judge-template-')(contract.html) : null;
  const outcome = htmlResult.cannot ? 'cannot' : htmlResult.errors.length === 0 ? 'pass' : 'html-fail';
  const failures = outcome === 'pass' ? expectationFailures(contractResult.contract, htmlResult.html, scenario.expect, rows.length) : [];
  if (outcome === 'pass' && chrome) {
    screenshot({ html: htmlResult.html, row: rows[0], chrome, workDir: dir, file: 'final-wide', width: 1100 });
    screenshot({ html: htmlResult.html, row: rows[0], chrome, workDir: dir, file: 'final-phone', width: 420, height: 1600 });
  }
  return {
    ...base,
    outcome,
    success: outcome === 'pass' && failures.length === 0,
    expectation_failures: failures,
    html_attempts: htmlResult.attempts,
    html_errors_by_attempt: htmlResult.history.map(({ attempt: n, errors, notes, cannot }) => ({ attempt: n, cannot: cannot ?? null, errors: [...errors, ...(notes ?? [])] })),
    html_message: htmlResult.message,
    layout_checks: judging ? htmlResult.checks : null,
    template_layout_checks: templateReview?.checks ?? null,
    questions: contractResult.contract.questions.map((q) => `${q.name}:${q.type}`),
    unit: contractResult.contract.unit ?? null,
    layout: contractResult.contract.layout ?? null,
    cost: addCost(contractResult.usage, htmlResult.usage, templateReview?.usage),
    calls: (contractResult.usage.calls ?? 0) + (htmlResult.usage.calls ?? 0),
    seconds: Math.round((Date.now() - started) / 100) / 10,
    hits: rows.length,
  };
}

function summary(results, meta) {
  const cell = (text) => String(text ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const lines = [
    '# 자유 계약 실험 결과',
    '',
    `- 시각: ${meta.started}`,
    `- writer: ${meta.writer}`,
    `- 렌더 검사: ${meta.render ? '했음 (Chrome)' : '하지 않음'}`,
    `- 성공 ${results.filter((r) => r.success && r.outcome !== 'skipped').length} / ${results.filter((r) => r.outcome !== 'skipped').length}, 비용 합계 $${results.reduce((sum, r) => sum + (r.cost ?? 0), 0).toFixed(4)}`,
    '',
    '| 시나리오 | 종류 | 결과 | 계약 시도 | HTML 시도 | 단위 | HIT | 문항 | 기대와 다른 점 | 배치 판정(최종) | 배치 판정(기본 페이지) | 비용 | 시간(초) |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const r of results) {
    const unit = r.unit ? `${r.unit.level}${r.unit.group_by ? `, group_by ${r.unit.group_by}` : ''}${r.unit.split ? `, split ${r.unit.split.by}` : ''}` : '-';
    lines.push(`| ${r.name} | ${r.kind} | ${r.success ? '성공' : '실패'} (${r.outcome}) | ${r.contract_attempts ?? '-'} | ${r.html_attempts ?? '-'} | ${cell(unit)} | ${r.hits ?? '-'} | ${cell((r.questions ?? []).join(', '))} | ${cell((r.expectation_failures ?? []).join('; ') || r.error || '')} | ${checksText(r.layout_checks)} | ${checksText(r.template_layout_checks)} | ${r.cost ? `$${r.cost.toFixed(4)}` : '-'} | ${r.seconds ?? '-'} |`);
  }
  lines.push('', '## 시도마다의 오류', '');
  for (const r of results) {
    for (const step of ['contract', 'html']) {
      for (const entry of r[`${step}_errors_by_attempt`] ?? []) if (entry.errors.length > 0) lines.push(`- **${r.name}** ${step} ${entry.attempt}회: ${cell(entry.errors.join(' / '))}`);
    }
  }
  if (results.some((r) => r.layout_checks)) {
    lines.push('', '## 배치 판정', '');
    for (const r of results) {
      for (const [title, checks] of [['최종', r.layout_checks], ['기본 페이지', r.template_layout_checks]]) {
        for (const check of checks ?? []) lines.push(`- **${r.name}** (${title}) ${check.result}: ${check.wish} — ${check.evidence}`);
      }
    }
  }
  lines.push('', '## Agent 의 설명(message)과 단위의 이유', '');
  for (const r of results) lines.push(`- **${r.name}**: 계약 — ${r.contract_message ?? '(없음)'} / 단위 — ${r.unit?.why ?? '(없음)'} / 페이지 — ${r.html_message ?? '(없음)'} / 페이지 문장 — ${cell((r.layout ?? []).join(' · ')) || '(없음)'}`);
  return `${lines.join('\n')}\n`;
}

const scenarios = JSON.parse(read('scripts/html_experiment/scenarios-free.json')).filter((s) => !args.only || args.only.split(',').includes(s.name));
const outRoot = resolve(args.out ?? join(ROOT, 'var/html-experiment', `${stamp()}-free-${args.writer}`));
const chrome = args['no-render'] ? null : findChrome();
if (!args['no-render'] && !chrome) console.warn('Chrome을 찾지 못해 렌더 검사 없이 진행합니다. CHROME 환경변수로 경로를 줄 수 있습니다.');
mkdirSync(outRoot, { recursive: true });

const started = new Date().toISOString();
const results = [];
for (const scenario of scenarios) {
  process.stdout.write(`${scenario.name} … `);
  try {
    const result = await runScenario(scenario, outRoot, chrome);
    results.push(result);
    console.log(`${result.success ? 'OK' : 'FAIL'} (${result.outcome}${result.cost ? `, $${result.cost.toFixed(4)}` : ''}${result.expectation_failures?.length ? `; ${result.expectation_failures.join('; ')}` : ''})`);
  } catch (error) {
    results.push({ name: scenario.name, kind: scenario.kind, outcome: 'error', success: false, error: error.message });
    console.log(`ERROR ${error.message}`);
  }
}
const meta = { started, writer: args.writer, render: Boolean(chrome) };
writeFileSync(join(outRoot, 'results.json'), JSON.stringify({ meta, results }, null, 2));
writeFileSync(join(outRoot, 'summary.md'), summary(results, meta));
console.log(`\n결과: ${outRoot}`);

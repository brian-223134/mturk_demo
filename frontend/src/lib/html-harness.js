// Agent 가 직접 쓴 템플릿 HTML 의 검사 (harness). binding 으로 콘솔이 조립한 템플릿을 정답지(계약)로 두고, Agent 의 HTML 이
//   - 정답지와 같은 데이터 컬럼을 모두, 같은 자리(글, 이미지·영상 주소, 항목 목록)로 보여 주는지
//   - 정답지와 같은 문항을 같은 이름과 같은 요소로 묻는지
//   - 대조 기준·attention 컬럼처럼 worker 에게 가면 안 되는 컬럼을 쓰지 않는지 (`${…}` 로 쓴 컬럼만 worker 에게 간다)
//   - 허용한 태그만 쓰고, 스크립트·이벤트 속성·외부 주소를 쓰지 않는지
// 를 본다. 배치와 표현(순서, 칸 나누기, 안내 글, 스타일)은 자유다.
// 화면에 그려 본 결과의 비교(compareRendered)도 여기 있다. 실제로 그리는 일은 scripts/html_experiment/ 가 Chrome 으로 한다.

import { boundData, buildBoundTemplate, checkBinding } from './design-binding.js';
import { ELEMENTS_SCRIPT, KNOWN_TAGS, lintLayout, scanTags } from './layout-lint.js';
import { extractPlaceholders } from './template.js';

/** 요소 사이에 섞어 써도 되는 일반 HTML. 입력 칸, 링크, 그림, 프레임은 없다 (문항은 ann 요소로만, 그림은 ann-image 로만). */
export const SAFE_HTML_TAGS = [
  'div', 'span', 'p', 'br', 'hr', 'strong', 'em', 'b', 'i', 'u', 'small', 'sub', 'sup', 'mark', 'code', 'pre', 'blockquote',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'section', 'header', 'footer', 'article', 'aside', 'figure', 'figcaption', 'details', 'summary',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'style', 'script',
];

/** 정답이 든 컬럼. 이 컬럼을 템플릿에 쓰면 worker 화면으로 정답이 나간다. */
export const ANSWER_COLUMNS = ['slot_reference', 'slot_attention'];

const COMMENT = /<!--[\s\S]*?-->/g;
const SCRIPT_JSON = /<script\b[^>]*type\s*=\s*["']application\/json["'][^>]*>([\s\S]*?)<\/script\s*>/gi;
const TAG_TEXT = /<[^>]*>/g;
const EXTERNAL = /^\s*(?:https?:)?\/\//i;
const STYLE_BODY = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi;
const DETAILS_BODY = /<details\b[^>]*>([\s\S]*?)<\/details\s*>/gi;
const DEAD_SELECTOR =/(?:^|[\s,>+~}(])ann-(?:option|item)(?![\w-])/;

/** 컬럼이 HTML 의 어디에 쓰였는지: text(화면 글), src(ann-image·ann-video 의 주소), json(항목 목록 script), attribute(그 밖의 속성). */
export function placeholderRoles(html) {
  const source = String(html).replace(COMMENT, '');
  const roles = new Map();
  const add = (name, role) => {
    if (!roles.has(name)) roles.set(name, new Set());
    roles.get(name).add(role);
  };
  for (const match of source.matchAll(SCRIPT_JSON)) for (const name of extractPlaceholders(match[1])) add(name, 'json');
  const withoutJson = source.replace(SCRIPT_JSON, '');
  for (const tag of scanTags(withoutJson)) {
    for (const [attribute, value] of Object.entries(tag.attributes)) {
      const role = attribute === 'src' && (tag.name === 'ann-image' || tag.name === 'ann-video') ? 'src' : 'attribute';
      for (const name of extractPlaceholders(value)) add(name, role);
    }
  }
  for (const name of extractPlaceholders(withoutJson.replace(TAG_TEXT, ' '))) add(name, 'text');
  return roles;
}

/**
 * binding 으로 만든 정답지와 그 계약. binding 이 검사를 통과하지 못하면 예외다.
 * → { html, data, shown: [컬럼], hidden: [컬럼], roles: {컬럼: 'text'|'src'|'json'}, questions: [{ tag, name }], answerColumns: [컬럼] }
 */
export function contractFor(binding, reader) {
  const check = checkBinding(binding, reader);
  if (check.errors.length > 0) throw new Error(`The binding does not pass its checks: ${check.errors.join(' ')}`);
  const html = buildBoundTemplate(binding, check.design, check.taskType, check.tabs);
  const data = boundData(binding, check.design, check.taskType, check.tabs, reader, 'hits.json');
  const shown = extractPlaceholders(html);
  const roles = Object.fromEntries([...placeholderRoles(html)].map(([name, set]) => [name, [...set][0]]));
  // 대조 기준과 attention 표시를 읽는 원래 컬럼도 정답이다
  const reference = binding.reference ?? {};
  const sources = [reference.value ?? reference.map ?? reference.selected, binding.attention?.flag]
    .filter((path) => typeof path === 'string').map((path) => path.split(/[[.]/)[0]);
  return {
    html,
    data,
    tabs: check.tabs,
    shown,
    hidden: data.columns.filter((column) => !shown.includes(column)),
    roles,
    questions: lintLayout(html).questions.map(({ tag, name }) => ({ tag, name })),
    answerColumns: [...new Set([...ANSWER_COLUMNS, ...sources])].filter((column) => data.columns.includes(column)),
  };
}

function listed(names, limit = 6) {
  const shown = names.slice(0, limit).map((name) => `"${name}"`).join(', ');
  return names.length > limit ? `${shown} and ${names.length - limit} more` : shown;
}

/** Agent 의 HTML 을 계약과 대조한다. → { errors, warnings }. 오류 문구는 그대로 Agent 에게 다시 보낸다 (영어). */
export function checkAgentHtml(html, contract) {
  const errors = [];
  const warnings = [];
  const text = String(html ?? '');
  if (text.trim() === '') return { errors: ['The HTML is empty.'], warnings };

  const lint = lintLayout(text);
  for (const problem of lint.problems) (problem.level === 'error' ? errors : warnings).push(problem.message);

  // 태그와 속성
  const allowed = new Set([...KNOWN_TAGS, ...SAFE_HTML_TAGS]);
  let elementScripts = 0;
  const notAllowed = new Set();
  for (const tag of scanTags(text.replace(COMMENT, ''))) {
    if (tag.closing) continue;
    if (!allowed.has(tag.name)) notAllowed.add(tag.name);
    if (tag.name === 'script') {
      const { src, type } = tag.attributes;
      if (src === ELEMENTS_SCRIPT) elementScripts += 1;
      else if (!(src === undefined && String(type).toLowerCase() === 'application/json')) errors.push(`Only <script src="${ELEMENTS_SCRIPT}"> and <script type="application/json"> item lists are allowed. Remove other scripts.`);
    }
    for (const [attribute, value] of Object.entries(tag.attributes)) {
      if (attribute.startsWith('on')) errors.push(`<${tag.name}> has the event attribute "${attribute}". Event attributes are not allowed.`);
      if (/javascript:/i.test(value)) errors.push(`<${tag.name}> uses a javascript: address. It is not allowed.`);
      if ((attribute === 'src' || attribute === 'href') && EXTERNAL.test(value) && !(tag.name === 'script' && value === ELEMENTS_SCRIPT)) errors.push(`<${tag.name}> loads "${value}". External addresses are not allowed; show data only through the columns.`);
    }
  }
  if (notAllowed.size > 0) errors.push(`These elements are not allowed: ${[...notAllowed].map((name) => `<${name}>`).join(', ')}. Use <ann-*> elements and plain text elements such as <div>, <p>, <strong>.`);
  if (elementScripts > 1) warnings.push(`<script src="${ELEMENTS_SCRIPT}"> appears ${elementScripts} times. Once is enough.`);
  if (/@import|url\(\s*["']?\s*(?:https?:)?\/\//i.test(text)) errors.push('The styles load an external address (@import or url(…)). It is not allowed.');
  // 요소는 <ann-option>, <ann-item> 을 숨기고 라벨을 새로 그리므로 그 태그를 겨냥한 스타일은 화면에 닿지 않는다
  const styles = [...text.replace(COMMENT, '').matchAll(STYLE_BODY)].map((match) => match[1]).join('\n');
  if (DEAD_SELECTOR.test(styles)) errors.push('Styles on <ann-option> or <ann-item> have no effect: the elements hide them and draw their own labels. Put markup inside the option, such as <ann-option value="v"><span class="x">Label</span></ann-option>, and style that class.');

  // 컬럼: 정답 누출, 없는 컬럼, 빠진 값, 자리
  const roles = placeholderRoles(text);
  const used = [...roles.keys()];
  const leaked = used.filter((name) => contract.answerColumns.includes(name));
  if (leaked.length > 0) errors.push(`${listed(leaked)} ${leaked.length === 1 ? 'holds' : 'hold'} the answers or attention checks. Never put ${leaked.length === 1 ? 'it' : 'them'} on the page.`);
  const extra = used.filter((name) => contract.hidden.includes(name) && !leaked.includes(name));
  if (extra.length > 0) errors.push(`${listed(extra)} ${extra.length === 1 ? 'is' : 'are'} not part of this page. Use only the columns of the current template.`);
  const unknown = used.filter((name) => !contract.shown.includes(name) && !contract.hidden.includes(name));
  if (unknown.length > 0) errors.push(`The data has no column ${listed(unknown)}.`);
  const missing = contract.shown.filter((name) => !roles.has(name));
  if (missing.length > 0) errors.push(`${listed(missing)} ${missing.length === 1 ? 'is' : 'are'} missing. Every value of the current template must stay on the page${missing.length > 1 ? ', in every tab' : ''}.`);
  for (const name of contract.shown) {
    const want = contract.roles[name];
    const have = roles.get(name);
    if (!have || have.has(want)) continue;
    const where = { text: 'as visible text', src: 'in the src of <ann-image> or <ann-video>', json: 'inside <script type="application/json"> of its question' }[want];
    errors.push(`"\${${name}}" must appear ${where}, as in the current template.`);
  }

  // 항목마다의 값(탭 번호가 붙은 컬럼)을 한 번 더 쓰면 한 항목의 값을 모든 항목의 값처럼 보이게 된다 (예: 1번 Query 를 맨 위에 "모두 같음"으로)
  const source = text.replace(COMMENT, '');
  if (contract.tabs > 0) {
    const repeated = contract.shown.filter((name) => /_\d+$/.test(name) && source.split(`\${${name}}`).length - 1 > 1);
    if (repeated.length > 0) errors.push(`${listed(repeated)} ${repeated.length === 1 ? 'belongs' : 'belong'} to one item but ${repeated.length === 1 ? 'appears' : 'appear'} more than once. Show each item's value once, with its own item; never show one item's value as if it were the same for every item.`);
  }
  // 접힌 상자 안의 값은 worker 가 열지 않으면 보지 못한다
  const folded = [...source.matchAll(DETAILS_BODY)].flatMap((match) => extractPlaceholders(match[1])).filter((name) => contract.shown.includes(name));
  if (folded.length > 0) errors.push(`${listed([...new Set(folded)])} ${folded.length === 1 ? 'is' : 'are'} inside a collapsed <details>. Every value must be visible without opening anything.`);

  // 문항
  const expected = new Map(contract.questions.map((q) => [q.name, q.tag]));
  const actual = new Map(lint.questions.map((q) => [q.name, q.tag]));
  const lost = [...expected.keys()].filter((name) => !actual.has(name));
  if (lost.length > 0) errors.push(`The questions ${listed(lost)} are missing. Keep every question of the current template with the same name.`);
  const added = [...actual.keys()].filter((name) => name && !expected.has(name));
  if (added.length > 0) errors.push(`The questions ${listed(added)} are not in the current template. Do not add or rename questions.`);
  for (const [name, tag] of actual) {
    if (expected.has(name) && expected.get(name) !== tag) errors.push(`The question "${name}" must stay <${expected.get(name)}>, not <${tag}>.`);
  }
  return { errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
}

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
const unescape = (text) => String(text).replace(/&(?:amp|lt|gt|quot|#39);/g, (entity) => ENTITIES[entity]);
const squash = (text) => String(text).replace(/\s+/g, ' ').trim();

function schemaKey(schema) {
  return JSON.stringify([...(schema ?? [])].map(({ name, type, values, required }) => ({ name, type, values, required })).sort((a, b) => a.name.localeCompare(b.name)));
}

/**
 * 그려 본 결과의 비교. rendered[i] = { schema: TASK_ANSWER_SCHEMA, text: 화면의 글, srcs: [주소], error? } 이고 reference 는 정답지를 그린 결과다.
 * → { errors: [{ row, message }] }. 답 칸은 순서와 상관없이 같아야 하고, 글 컬럼의 값은 화면 글에, 주소 컬럼의 값은 srcs 에 있어야 한다.
 */
export function compareRendered(contract, reference, rendered) {
  const errors = [];
  rendered.forEach((page, row) => {
    if (page.error) {
      errors.push({ row, message: `The page failed to render: ${page.error}` });
      return;
    }
    if (schemaKey(page.schema) !== schemaKey(reference[row]?.schema)) errors.push({ row, message: 'The answer fields differ from the current template (names, types or option values).' });
    const values = contract.data.rows[row] ?? {};
    const text = squash(page.text);
    const missingText = contract.shown.filter((name) => contract.roles[name] === 'text' && squash(unescape(values[name] ?? '')) !== '' && !text.includes(squash(unescape(values[name]))));
    if (missingText.length > 0) errors.push({ row, message: `The values of ${listed(missingText)} are not shown as text.` });
    const missingSrc = contract.shown.filter((name) => contract.roles[name] === 'src' && values[name] && !(page.srcs ?? []).some((src) => src.includes(values[name])));
    if (missingSrc.length > 0) errors.push({ row, message: `The addresses of ${listed(missingSrc)} are not used by an image or video.` });
  });
  return { errors };
}

const SAMPLE_CHARS = 200;
const clip = (text) => (text.length > SAMPLE_CHARS ? `${text.slice(0, SAMPLE_CHARS)}… (${text.length} characters)` : text);

/** HTML Agent(POST /api/agent/pages)에게 보낼 요청. 정답이 든 컬럼은 이름도 넣지 않는다. */
export function pageRequest(contract, requestText, taskType) {
  const first = contract.data.rows[0] ?? {};
  return {
    task_type: taskType,
    request: requestText,
    template: contract.html,
    columns: contract.shown.map((name) => ({ name, role: contract.roles[name], sample: clip(unescape(first[name] ?? '')) })),
    questions: contract.questions,
  };
}

/**
 * Agent 에게 HTML 을 묻고 검사한다. 오류가 있으면 오류와 이전 답을 붙여 maxAttempts 번까지 다시 묻는다 (requestBinding 과 같은 모양).
 * send(body) → { html, message, cannot?, usage? }, check(html) → { errors } (비동기 가능).
 * → { html, message, cannot, errors, attempts, usage, history: [{ attempt, errors, usage }] }
 */
export async function requestHtml({ send, check, request, maxAttempts = 3 }) {
  let previous = null;
  let errors = [];
  const usage = { calls: 0 };
  const history = [];
  let last = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const reply = await send(errors.length > 0 ? { ...request, previous, errors } : request);
    last = reply;
    for (const [key, value] of Object.entries(reply.usage ?? {})) {
      if (typeof value === 'number') usage[key] = (usage[key] ?? 0) + value;
    }
    const common = { message: reply.message ?? null, attempts: attempt, usage, history };
    if (reply.cannot) {
      history.push({ attempt, cannot: reply.cannot, errors: [], usage: reply.usage ?? null });
      return { ...common, html: null, cannot: reply.cannot, errors: [] };
    }
    errors = (await check(reply.html)).errors;
    history.push({ attempt, errors, usage: reply.usage ?? null });
    if (errors.length === 0) return { ...common, html: reply.html, cannot: null, errors };
    previous = reply.html;
  }
  return { html: last.html, message: last.message ?? null, cannot: null, errors, attempts: maxAttempts, usage, history };
}

// Design Layout 의 검사: 편집 중인 템플릿 HTML 을 훑어 <ann-*> 요소를 잘못 쓴 곳을 알린다. 브라우저의 DOMParser 대신 정규식으로
// 태그와 속성만 읽으므로 Node 에서 테스트할 수 있다 (tests/layout-lint.test.js). 화면에 그려 보지 않고 알 수 있는 것만 본다.
// 답 칸의 실제 목록은 미리보기가 window.TASK_ANSWER_SCHEMA 로 보고한다.

import { extractPlaceholders } from './template.js';

export const ELEMENTS_SCRIPT = '/elements/ann-elements.js';
export const QUESTION_TAGS = ['ann-choice', 'ann-likert', 'ann-checklist', 'ann-textarea'];
export const KNOWN_TAGS = ['ann-form', 'ann-instructions', 'ann-text', ...QUESTION_TAGS, 'ann-option', 'ann-item', 'ann-tabs', 'ann-tab'];

const TAG = /<(\/?)([A-Za-z][\w-]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
const ATTRIBUTE = /([^\s"'=<>`/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

/** 주석과 <script>, <style> 의 본문을 지운다 (여는 태그는 남겨 script src 를 볼 수 있게). */
function stripBodies(html) {
  return String(html)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/(<script\b[^>]*>)[\s\S]*?<\/script\s*>/gi, '$1</script>')
    .replace(/(<style\b[^>]*>)[\s\S]*?<\/style\s*>/gi, '$1</style>');
}

export function parseAttributes(text) {
  const attributes = {};
  for (const match of String(text).matchAll(ATTRIBUTE)) {
    const name = match[1].toLowerCase();
    if (name in attributes) continue;
    attributes[name] = match[2] ?? match[3] ?? match[4] ?? '';
  }
  return attributes;
}

/** 태그 목록 [{ name, closing, attributes, index, end }] (소문자 이름). */
export function scanTags(html) {
  const source = stripBodies(html);
  const tags = [];
  for (const match of source.matchAll(TAG)) {
    tags.push({ name: match[2].toLowerCase(), closing: match[1] === '/', attributes: match[1] === '/' ? {} : parseAttributes(match[3]), index: match.index, end: match.index + match[0].length });
  }
  return tags;
}

/** 여는 태그 open 의 짝인 닫는 태그까지 사이의 태그들. 같은 이름이 안에 또 열려도 깊이를 센다. */
function innerTags(tags, openIndex) {
  const open = tags[openIndex];
  let depth = 0;
  const inner = [];
  for (let i = openIndex + 1; i < tags.length; i++) {
    const tag = tags[i];
    if (tag.name === open.name) {
      if (!tag.closing) depth++;
      else if (depth === 0) return inner;
      else depth--;
    }
    inner.push(tag);
  }
  return inner;
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/**
 * → { kind, placeholders, questions: [{ tag, name }], problems: [{ level: 'error'|'warning'|'info', message }] }
 * kind 는 'ann'(이 콘솔의 요소), 'crowd'(MTurk 의 crowd-html-elements), 'html'(그 밖의 HTML), 'empty'.
 * error 가 있으면 Project 를 저장할 수 없다 (Finish 가 막힌다).
 */
export function lintLayout(html) {
  const problems = [];
  const text = String(html ?? '');
  if (text.trim() === '') return { kind: 'empty', placeholders: [], questions: [], problems: [{ level: 'error', message: 'The layout is empty.' }] };

  const tags = scanTags(text);
  const opens = tags.filter((tag) => !tag.closing);
  const usesAnn = opens.some((tag) => tag.name.startsWith('ann-'));
  const scripts = opens.filter((tag) => tag.name === 'script' && tag.attributes.src);
  const hasElementsScript = scripts.some((tag) => tag.attributes.src.split(/[?#]/)[0].endsWith('/ann-elements.js'));
  const usesCrowd = opens.some((tag) => tag.name.startsWith('crowd-')) || scripts.some((tag) => tag.attributes.src.includes('assets.crowd.aws'));
  const kind = usesAnn ? 'ann' : usesCrowd ? 'crowd' : 'html';

  if (usesAnn && !hasElementsScript) {
    problems.push({ level: 'error', message: `Add <script src="${ELEMENTS_SCRIPT}"></script> at the top. Without it the <ann-*> elements are not drawn.` });
  }
  const unknown = [...new Set(opens.filter((tag) => tag.name.startsWith('ann-') && !KNOWN_TAGS.includes(tag.name)).map((tag) => tag.name))];
  for (const name of unknown) problems.push({ level: 'warning', message: `Unknown element <${name}>. It is shown as plain content. Check the spelling.` });

  const questions = [];
  const seen = new Map();
  const outside = [];
  let formDepth = 0;
  tags.forEach((tag, index) => {
    if (tag.name === 'ann-form') formDepth = Math.max(0, formDepth + (tag.closing ? -1 : 1));
    if (tag.closing || !QUESTION_TAGS.includes(tag.name)) return;
    const name = tag.attributes.name ?? '';
    const number = questions.filter((q) => q.tag === tag.name).length + 1;
    const label = name ? `<${tag.name} name="${name}">` : `<${tag.name}> #${number}`;
    questions.push({ tag: tag.name, name });
    if (formDepth === 0) outside.push(label);
    if (name === '') {
      problems.push({ level: 'error', message: `${label} has no name. Every question needs a unique name; it becomes the answer name in Review and the results.` });
    } else {
      if (!NAME.test(name) && !name.includes('${')) {
        problems.push({ level: 'warning', message: `${label}: use letters, digits and _ in the name, starting with a letter or _.` });
      }
      seen.set(name, (seen.get(name) ?? 0) + 1);
    }
    if (tag.name === 'ann-choice') {
      const options = innerTags(tags, index).filter((t) => !t.closing && t.name === 'ann-option').length;
      const shorthand = (tag.attributes.options ?? '').split(',').filter((s) => s.trim() !== '').length;
      if (options === 0 && shorthand === 0) problems.push({ level: 'error', message: `${label} has no options. Add <ann-option value="…"> children or options="a, b".` });
      if (options + shorthand === 1) problems.push({ level: 'warning', message: `${label} has only one option.` });
    }
    if (tag.name === 'ann-likert') {
      const min = Number.parseInt(tag.attributes.min ?? '1', 10);
      const max = Number.parseInt(tag.attributes.max ?? '5', 10);
      if (!Number.isInteger(min) || !Number.isInteger(max) || max <= min) problems.push({ level: 'error', message: `${label}: max must be a whole number greater than min.` });
    }
    if (tag.name === 'ann-checklist') {
      const inner = innerTags(tags, index);
      const items = inner.filter((t) => !t.closing && t.name === 'ann-item').length;
      const json = inner.some((t) => !t.closing && t.name === 'script' && /json/i.test(t.attributes.type ?? ''));
      if (items === 0 && !json) {
        problems.push({ level: 'info', message: `${label} reads its items from its text (a JSON array or one item per line). A <script type="application/json"> child is safer for column values.` });
      }
    }
  });
  for (const [name, count] of seen) {
    if (count > 1) problems.push({ level: 'error', message: `The name "${name}" is used by ${plural(count, 'question')}. Each question needs its own name.` });
  }

  const forms = opens.filter((tag) => tag.name === 'ann-form').length;
  if (questions.length > 0 && forms === 0) {
    problems.push({ level: 'error', message: 'Put the questions inside <ann-form>. Without it there is no Submit button and the answers cannot be sent.' });
  } else if (outside.length > 0) {
    problems.push({ level: 'error', message: `${outside.join(', ')} ${outside.length === 1 ? 'is' : 'are'} outside <ann-form>. Move ${outside.length === 1 ? 'it' : 'them'} inside the form, or the answers are not sent.` });
  }
  if (forms > 1) problems.push({ level: 'warning', message: `The layout has ${forms} <ann-form> elements. Use one form so that one Submit sends every answer.` });
  if (usesAnn && forms > 0 && questions.length === 0) problems.push({ level: 'warning', message: 'The form has no questions (ann-choice, ann-likert, ann-checklist, ann-textarea).' });

  if (usesCrowd) {
    problems.push({ level: 'info', message: 'This layout uses crowd-html-elements loaded from assets.crowd.aws, which this console does not host. Layouts built with <ann-*> elements do not depend on it.' });
  } else if (!usesAnn) {
    problems.push({ level: 'info', message: 'This layout does not use <ann-*> elements. The preview reads its answers from input_answers or from the form fields when you submit.' });
  }
  return { kind, placeholders: extractPlaceholders(text), questions, problems };
}

/** 오류가 있는지. */
export function hasLayoutErrors(result) {
  return result.problems.some((problem) => problem.level === 'error');
}

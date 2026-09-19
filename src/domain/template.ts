// 5.5 Task 페이지(템플릿) 규약: placeholder 추출, 데이터 주입, 미리보기용 제출 가로채기

const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** html에서 `${컬럼명}` placeholder 이름을 처음 나온 순서대로, 중복 없이 뽑는다. */
export function extractPlaceholders(html: string): string[] {
  const names = new Set<string>();
  for (const match of html.matchAll(PLACEHOLDER)) names.add(match[1]!);
  return [...names];
}

/** `<script>` 안에 넣어도 안전한 JSON. `</script>`나 `<!--`가 데이터에 있어도 문서를 깨지 않는다. */
export function jsonForScript(value: unknown): string {
  // U+2028, U+2029는 JSON에서는 허용되지만 예전 JS 엔진은 문자열 안의 줄바꿈으로 읽는다
  const lineSeparators = new RegExp(`[${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}]`, 'g');
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(lineSeparators, (ch) => `\\u${ch.charCodeAt(0).toString(16)}`);
}

/** `<head>` 맨 앞에 끼워 넣는다. 기존 템플릿처럼 `<head>`가 없는 조각이면 문서 맨 앞에 둔다. */
function injectAtHeadStart(html: string, snippet: string): string {
  const head = /<head(\s[^>]*)?>/i.exec(html);
  if (!head) return snippet + html;
  const at = head.index + head[0].length;
  return html.slice(0, at) + snippet + html.slice(at);
}

export const PREVIEW_MESSAGE_SOURCE = 'mturk-console-preview';

export interface PreviewMessage {
  source: typeof PREVIEW_MESSAGE_SOURCE;
  type: 'submit' | 'schema';
  /** submit: 제출된 응답. input_answers 필드가 있으면 그 값, 없으면 폼 필드 전체 */
  answers?: { name: string; value: string }[];
  /** schema: 화면에 있는 문항의 name과 선택지 */
  fields?: { name: string; values: string[] }[];
}

/**
 * 미리보기 iframe 안에서 실행되는 스크립트. 콘솔 앱과는 postMessage로만 통신한다 (iframe에 allow-same-origin이 없다).
 *
 * 제출 가로채기
 *  - submit 이벤트는 capture 단계에서 항상 취소한다. iframe이 MTurk의 제출 주소로 이동해 버리지 않게 하려는 것이다.
 *  - 보고는 템플릿 자신의 핸들러가 끝난 뒤에 한다. 템플릿이 제출을 거부했는지(미응답 등)는 input_answers로 가린다:
 *    그 필드가 있는 템플릿이면 값이 채워졌을 때만 보고하고, 보고한 뒤에는 비워서 다음 거부를 이전 값으로 오해하지 않는다.
 *  - 기존 템플릿은 hidden input_answers를 채운 뒤 crowd-form의 submit()을 코드로 호출한다. 이 경우 submit 이벤트가
 *    나지 않으므로 submit 메서드도 바꿔 둔다.
 *
 * 문항 읽기
 *  - 화면의 라디오, 체크박스, select에서 name과 선택지를 읽어 보낸다. 템플릿이 JS로 문항을 그리므로 문서가 바뀌면 다시 읽는다.
 *  - 기존 템플릿은 DOM을 쉬지 않고 바꾼다(초당 수백 번). "조용해지면 읽기"만으로는 영영 읽지 못하므로 최대 대기 시간을 둔다.
 *  - 기존 템플릿은 문항을 한 번에 하나씩만 그린다. 그래서 읽은 문항을 누적한다 (미리보기에서 눌러 본 만큼 모인다).
 */
const PREVIEW_BRIDGE = `(function () {
  var SOURCE = ${JSON.stringify(PREVIEW_MESSAGE_SOURCE)};
  function send(message) { message.source = SOURCE; parent.postMessage(message, '*'); }

  function readAnswers() {
    var hidden = document.querySelector('[name="input_answers"]');
    if (hidden && hidden.value) {
      try {
        var parsed = JSON.parse(hidden.value);
        if (Array.isArray(parsed)) {
          return parsed.map(function (a) { return { name: String(a.name), value: String(a.value) }; });
        }
      } catch (e) { /* 아래의 폼 필드 읽기로 넘어간다 */ }
    }
    var answers = [];
    document.querySelectorAll('input, select, textarea').forEach(function (el) {
      if (!el.name || el.name === 'assignmentId' || el.name === 'input_answers') return;
      if ((el.type === 'radio' || el.type === 'checkbox') && !el.checked) return;
      answers.push({ name: el.name, value: String(el.value) });
    });
    return answers;
  }
  function inputAnswersField() { return document.querySelector('[name="input_answers"]'); }
  function reportSubmit() {
    setTimeout(function () {
      var hidden = inputAnswersField();
      if (hidden && !hidden.value) return; // 템플릿이 제출을 거부했다 (input_answers를 채우지 않았다)
      send({ type: 'submit', answers: readAnswers() });
      if (hidden) hidden.value = '';
    }, 0);
  }

  window.addEventListener('submit', function (event) { event.preventDefault(); reportSubmit(); }, true);
  HTMLFormElement.prototype.submit = reportSubmit;
  if (window.customElements && customElements.whenDefined) {
    customElements.whenDefined('crowd-form').then(function () {
      customElements.get('crowd-form').prototype.submit = reportSubmit;
    });
  }

  var byName = {};
  var order = [];
  var lastSchema = '';
  function reportSchema() {
    function add(name, value) {
      if (!name || name === 'input_answers' || name === 'assignmentId') return;
      if (!byName[name]) { byName[name] = []; order.push(name); }
      if (value !== undefined && value !== '' && byName[name].indexOf(value) < 0) byName[name].push(value);
    }
    document.querySelectorAll('input[type="radio"], input[type="checkbox"]').forEach(function (el) { add(el.name, el.value); });
    document.querySelectorAll('select').forEach(function (el) {
      Array.prototype.forEach.call(el.options, function (o) { add(el.name, o.value); });
    });
    var fields = order.map(function (name) { return { name: name, values: byName[name] }; });
    var text = JSON.stringify(fields);
    if (text === lastSchema) return;
    lastSchema = text;
    send({ type: 'schema', fields: fields });
  }
  var QUIET_MS = 300;
  var MAX_WAIT_MS = 1500;
  var timer = null;
  var waitingSince = 0;
  function scheduleSchema() {
    var now = Date.now();
    if (timer === null) waitingSince = now;
    clearTimeout(timer);
    timer = setTimeout(function () { timer = null; reportSchema(); }, Math.max(0, Math.min(QUIET_MS, waitingSince + MAX_WAIT_MS - now)));
  }
  window.addEventListener('load', scheduleSchema);
  document.addEventListener('DOMContentLoaded', function () {
    new MutationObserver(scheduleSchema).observe(document.documentElement, { childList: true, subtree: true });
    scheduleSchema();
  });
})();`;

export interface RenderOptions {
  /** 미리보기용 스크립트(제출 가로채기, 문항 읽기)를 넣는다. worker에게 보낼 HTML에는 넣지 않는다. */
  preview?: boolean;
}

/**
 * CSV 1행으로 템플릿을 렌더한다. 두 방식을 모두 적용한다 (5.5).
 *  - `${컬럼명}` 치환: 셀 문자열을 escape 없이 그대로 끼워 넣는다 (MTurk Requester 웹사이트와 같은 동작).
 *    행에 없는 이름은 그대로 둔다.
 *  - `window.TASK_DATA`: 행 전체를 JSON 객체로 만들어 `<head>` 맨 앞의 script로 주입한다.
 */
export function renderTemplate(html: string, row: Record<string, string>, options: RenderOptions = {}): string {
  // 셀에 "$&"나 "$1"이 있어도 치환 패턴으로 해석되지 않게 함수로 바꾼다
  const substituted = html.replace(PLACEHOLDER, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(row, name) ? row[name]! : whole,
  );
  let snippet = `<script>window.TASK_DATA = ${jsonForScript(row)};</script>`;
  if (options.preview) snippet += `<script>${PREVIEW_BRIDGE}</script>`;
  return injectAtHeadStart(substituted, snippet);
}

// "Open task": 그 HIT 의 입력으로 batch 의 템플릿 사본을 렌더해 worker 가 본 화면을 띄운다.
// 목록은 입력을 잘라서 주므로 getHit 으로 전체 입력을 받는다. iframe 은 sandbox="allow-scripts allow-forms" 라
// 템플릿의 JS 는 콘솔 앱(쿠키, 저장소, DOM)에 접근할 수 없고, 제출은 안의 스크립트가 가로채 postMessage 로만 알린다.

import { api } from '../../api-client/client.js';
import { el } from '../../components/dom.js';
import { openModal } from '../../components/modal.js';
import { errorNotice, loading } from '../../components/notice.js';
import { replace } from '../../components/render.js';

const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
export const PREVIEW_MESSAGE_SOURCE = 'mturk-console-preview';

/** `<script>` 안에 넣어도 안전한 JSON. `</script>` 나 `<!--` 가 데이터에 있어도 문서를 깨지 않는다. */
export function jsonForScript(value) {
  const lineSeparators = new RegExp(`[${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}]`, 'g');
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(lineSeparators, (ch) => `\\u${ch.charCodeAt(0).toString(16)}`);
}

/** `<head>` 맨 앞에 끼워 넣는다. `<head>` 가 없는 조각이면 문서 맨 앞에 둔다. */
function injectAtHeadStart(html, snippet) {
  const head = /<head(\s[^>]*)?>/i.exec(html);
  if (!head) return snippet + html;
  const at = head.index + head[0].length;
  return html.slice(0, at) + snippet + html.slice(at);
}

// 미리보기 iframe 안에서 실행된다. submit 은 capture 단계에서 항상 취소하고(iframe 이 MTurk 로 이동하지 않게),
// 템플릿 자신의 핸들러가 끝난 뒤 input_answers(있으면) 또는 폼 필드를 읽어 부모에게 보낸다.
// 기존 템플릿은 hidden input_answers 를 채운 뒤 crowd-form 의 submit() 을 코드로 부르므로 그 메서드도 바꿔 둔다.
const PREVIEW_BRIDGE = `(function () {
  var SOURCE = ${JSON.stringify(PREVIEW_MESSAGE_SOURCE)};
  function send(message) { message.source = SOURCE; parent.postMessage(message, '*'); }
  function readAnswers() {
    var hidden = document.querySelector('[name="input_answers"]');
    if (hidden && hidden.value) {
      try {
        var parsed = JSON.parse(hidden.value);
        if (Array.isArray(parsed)) return parsed.map(function (a) { return { name: String(a.name), value: String(a.value) }; });
      } catch (e) { /* 폼 필드 읽기로 넘어간다 */ }
    }
    var answers = [];
    document.querySelectorAll('input, select, textarea').forEach(function (el) {
      if (!el.name || el.name === 'assignmentId' || el.name === 'input_answers') return;
      if ((el.type === 'radio' || el.type === 'checkbox') && !el.checked) return;
      answers.push({ name: el.name, value: String(el.value) });
    });
    return answers;
  }
  function reportSubmit() {
    setTimeout(function () {
      var hidden = document.querySelector('[name="input_answers"]');
      if (hidden && !hidden.value) return;
      send({ type: 'submit', answers: readAnswers() });
      if (hidden) hidden.value = '';
    }, 0);
  }
  window.addEventListener('submit', function (event) { event.preventDefault(); reportSubmit(); }, true);
  HTMLFormElement.prototype.submit = reportSubmit;
  if (window.customElements && customElements.whenDefined) {
    customElements.whenDefined('crowd-form').then(function () { customElements.get('crowd-form').prototype.submit = reportSubmit; });
  }
})();`;

/**
 * CSV 1행으로 템플릿을 렌더한다. `${컬럼명}` 은 셀 문자열로 escape 없이 치환하고(MTurk Requester 웹사이트와 같다),
 * 행 전체는 `window.TASK_DATA` 로 `<head>` 맨 앞에 넣는다. preview 면 제출을 가로채는 스크립트도 넣는다.
 */
export function renderTemplate(html, row, { preview = false } = {}) {
  const substituted = html.replace(PLACEHOLDER, (whole, name) => (Object.prototype.hasOwnProperty.call(row, name) ? row[name] : whole));
  let snippet = `<script>window.TASK_DATA = ${jsonForScript(row)};</script>`;
  if (preview) snippet += `<script>${PREVIEW_BRIDGE}</script>`;
  return injectAtHeadStart(substituted, snippet);
}

/** 미리보기 iframe 과 "Submit intercepted" 안내. dispose() 로 message 리스너를 뗀다. */
export function taskPreviewFrame(html, row, { height = '70vh' } = {}) {
  const iframe = el('iframe', { title: 'Task preview', className: 'task-frame', sandbox: 'allow-scripts allow-forms', style: { height } });
  iframe.srcdoc = renderTemplate(html, row, { preview: true });
  const submitted = el('div', { className: 'task-submitted', hidden: true });
  const root = el('div', { className: 'task-preview' }, iframe, submitted);

  const onMessage = (event) => {
    // origin 은 sandbox 때문에 "null" 이라 비교할 수 없다. 이 iframe 의 창에서 온 메시지인지로 가린다
    if (event.source !== iframe.contentWindow) return;
    if (event.data?.source !== PREVIEW_MESSAGE_SOURCE || event.data.type !== 'submit') return;
    const answers = event.data.answers ?? [];
    submitted.hidden = false;
    replace(submitted, 
      el(
        'div',
        { className: 'notice notice-success' },
        el(
          'div',
          { className: 'notice-title task-submitted-head' },
          `Submit intercepted: ${answers.length} answer(s). Nothing was sent to MTurk.`,
          el('button', { type: 'button', className: 'btn btn-small', onClick: () => (submitted.hidden = true) }, 'Clear'),
        ),
        el('pre', { className: 'pre' }, `input_answers = ${JSON.stringify(answers, null, 2)}`),
      ),
    );
  };
  window.addEventListener('message', onMessage);
  return { root, iframe, dispose: () => window.removeEventListener('message', onMessage) };
}

/** HIT 하나의 task 화면을 모달로 연다. */
export function openTaskPreview({ batch, hitId, rowIndex }) {
  const body = el('div', {}, loading());
  let frame = null;
  const modal = openModal({
    title: `Task preview · row ${rowIndex} · HIT ${hitId}`,
    width: 1180,
    className: 'modal-task',
    content: body,
    onClose: () => frame?.dispose(),
  });
  api
    .getHit(hitId)
    .then((hit) => {
      frame = taskPreviewFrame(batch.templateHtml, hit.input);
      replace(body, frame.root);
    })
    .catch((error) => replace(body, errorNotice(error, 'HIT')));
  return modal;
}

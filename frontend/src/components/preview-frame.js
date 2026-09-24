// 미리보기 환경. 템플릿을 CSV 1행으로 렌더해 worker 가 보는 화면 그대로 띄운다 (prototype/src/components/TaskPreviewFrame.tsx).
// sandbox 에 allow-same-origin 을 주지 않으므로 템플릿의 JS 는 콘솔 앱(쿠키, 저장소, DOM)에 접근할 수 없고,
// 콘솔과는 postMessage 로만 통신한다 (lib/template.js 의 PREVIEW_BRIDGE).
// allow-forms 는 필요하다. 없으면 브라우저가 submit 이벤트를 내기도 전에 제출을 막아서 가로챌 수가 없다.
// 실제 제출은 PREVIEW_BRIDGE 가 항상 취소하므로 iframe 이 다른 주소로 이동하지는 않는다.

import { PREVIEW_MESSAGE_SOURCE, renderTemplate } from '../lib/template.js';
import { el } from './dom.js';
import { notice } from './notice.js';

/**
 * previewFrame({ html, row, height, onSchema, onSubmit }) → { node, destroy }.
 * onSchema(fields) 는 화면에서 읽어 낸 문항 목록 (name 과 선택지), onSubmit(answers) 는 가로챈 제출이다.
 * 내용이 바뀌면 새로 만든다 (srcdoc 만 바꾸면 이전 문서의 스크립트 상태가 남는 브라우저가 있다). destroy 로 message 리스너를 뗀다.
 */
export function previewFrame({ html, row, height = 640, onSchema, onSubmit }) {
  const iframe = el('iframe', { title: 'Task preview', sandbox: 'allow-scripts allow-forms', className: 'preview-frame', style: { height: `${height}px` } });
  iframe.srcdoc = renderTemplate(html, row, { preview: true });
  const result = el('div', { className: 'preview-result', id: 'submit-intercepted' });
  const node = el('div', { className: 'preview-frame-wrap' }, iframe, result);

  function showSubmitted(answers) {
    const clear = el('button', { type: 'button', className: 'btn btn-small', onClick: () => result.replaceChildren() }, 'Clear');
    result.replaceChildren(
      notice(
        'success',
        el('span', { className: 'notice-row' }, el('span', {}, `Submit intercepted: ${answers.length} answer(s). Nothing was sent to MTurk.`), clear),
        null,
        el('pre', { className: 'pre answers-json' }, `input_answers = ${JSON.stringify(answers, null, 2)}`),
      ),
    );
  }

  function onMessage(event) {
    // origin 은 sandbox 때문에 "null" 이라 비교할 수 없다. 이 iframe 의 창에서 온 메시지인지로 가린다.
    if (event.source !== iframe.contentWindow) return;
    const data = event.data;
    if (!data || data.source !== PREVIEW_MESSAGE_SOURCE) return;
    if (data.type === 'submit') {
      const answers = Array.isArray(data.answers) ? data.answers : [];
      showSubmitted(answers);
      if (onSubmit) onSubmit(answers);
    }
    if (data.type === 'schema' && onSchema) onSchema(Array.isArray(data.fields) ? data.fields : []);
  }
  window.addEventListener('message', onMessage);

  return { node, destroy: () => window.removeEventListener('message', onMessage) };
}

// "Open task": 그 HIT 의 입력으로 batch 의 템플릿 사본을 렌더해 worker 가 본 화면을 띄운다.
// 목록은 입력을 잘라서 주므로 getHit 으로 전체 입력을 받는다. iframe 은 sandbox="allow-scripts allow-forms" 라
// 템플릿의 JS 는 콘솔 앱(쿠키, 저장소, DOM)에 접근할 수 없고, 제출은 안의 스크립트가 가로채 postMessage 로만 알린다.
// 렌더와 안의 스크립트는 Create 의 미리보기와 같은 것(lib/template.js 의 renderTemplate, PREVIEW_BRIDGE)을 쓴다.
// 그 스크립트가 보내는 문항 목록(schema, window.TASK_ANSWER_SCHEMA 를 먼저 본다)은 여기서는 쓰지 않는다.

import { api } from '../../api-client/client.js';
import { el } from '../../components/dom.js';
import { openModal } from '../../components/modal.js';
import { errorNotice, loading } from '../../components/notice.js';
import { replace } from '../../components/render.js';
import { PREVIEW_MESSAGE_SOURCE, renderTemplate } from '../../lib/template.js';

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

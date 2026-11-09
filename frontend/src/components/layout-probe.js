// 페이지를 화면 밖의 미리보기 iframe 에 그려 칸의 측정값을 받는다 (요청한 배치의 자동 확인, lib/layout-check.js).
// 미리보기와 같은 sandbox iframe 과 bridge 를 쓰므로 템플릿의 스크립트는 콘솔에 닿지 않는다. 측정값이 QUIET_MS 동안 바뀌지 않으면 끝낸다.

import { previewFrame } from './preview-frame.js';

const QUIET_MS = 700;

/** measurePage(html, row, { width, height, timeoutMs }) → Promise<{ width, tabs, blocks }>. 시간 안에 받지 못하면 실패한다. */
export function measurePage(html, row, { width = 1100, height = 1400, timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    let last = null;
    let quiet = null;
    const finish = (error) => {
      clearTimeout(quiet);
      clearTimeout(limit);
      frame.destroy();
      holder.remove();
      if (error) reject(error);
      else resolve(last);
    };
    const frame = previewFrame({
      html,
      row,
      height,
      showSubmitted: false,
      title: 'Layout probe',
      onLayout: (page) => {
        last = page;
        clearTimeout(quiet);
        quiet = setTimeout(() => finish(null), QUIET_MS);
      },
    });
    const limit = setTimeout(() => (last ? finish(null) : finish(new Error('The page could not be measured in time.'))), timeoutMs);
    // 보이지 않게 두되 배치는 실제로 계산되도록 화면 밖에 고정 폭으로 놓는다
    const holder = document.createElement('div');
    holder.setAttribute('aria-hidden', 'true');
    Object.assign(holder.style, { position: 'fixed', left: '-20000px', top: '0', width: `${width}px`, pointerEvents: 'none' });
    frame.iframe.style.width = `${width}px`;
    holder.append(frame.node);
    document.body.append(holder);
  });
}

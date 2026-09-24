// 모달과 drawer 가 함께 쓰는 겹침 창 스택. Escape 는 맨 위의 것만 닫고, 페이지를 떠날 때는 closeAllOverlays 로 전부 닫는다.
// 창 자체는 modal.js 와 drawer.js 가 만들고, 여기서는 순서와 키 처리만 맡는다.

const stack = [];
let listening = false;

function onKeyDown(event) {
  if (event.key !== 'Escape' || stack.length === 0) return;
  const top = stack[stack.length - 1];
  if (top.canClose()) {
    event.preventDefault();
    top.close();
  }
}

/** entry: { close(), canClose() → boolean }. 돌려주는 함수로 스택에서 뺀다. */
export function pushOverlay(entry) {
  stack.push(entry);
  if (!listening) {
    document.addEventListener('keydown', onKeyDown);
    listening = true;
  }
  return () => {
    const index = stack.indexOf(entry);
    if (index >= 0) stack.splice(index, 1);
  };
}

export function overlayDepth() {
  return stack.length;
}

/** 열려 있는 창을 위에서부터 전부 닫는다 (페이지 이동 시 cleanup). */
export function closeAllOverlays() {
  for (const entry of [...stack].reverse()) entry.close();
}

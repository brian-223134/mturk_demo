// DOM 을 만드는 작은 도우미. 문자열 자식은 항상 텍스트 노드로 넣으므로 API 데이터가 HTML 로 해석되는 일이 없다.

/**
 * el('a', { href: '/manage', className: 'link', dataset: { id }, onClick: fn }, '텍스트', 다른노드, [배열도 됨])
 * 속성값이 null, undefined, false 면 넣지 않는다. true 면 빈 속성(disabled 등)으로 넣는다.
 */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'className') node.className = value;
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key === 'value' || key === 'checked' || key === 'selected') node[key] = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }
  append(node, children);
  return node;
}

/** 자식 목록을 붙인다. 문자열과 숫자는 텍스트 노드가 되고, null/undefined/false 는 건너뛴다. 배열은 편다. */
export function append(node, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** innerHTML 에 문자열을 넣어야 할 때 쓴다 (이 앱에서는 데이터를 textContent 로만 넣으므로 예비용). */
export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function clear(node) {
  node.replaceChildren();
  return node;
}

/** 목록을 구분자로 이어 붙인다 (텍스트와 노드 섞어서). */
export function join(items, separator = ', ') {
  const out = [];
  items.forEach((item, i) => {
    if (i > 0) out.push(separator);
    out.push(item);
  });
  return out;
}

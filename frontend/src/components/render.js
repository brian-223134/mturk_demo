// node 의 자식을 통째로 바꾼다. replaceChildren 과 달리 null 과 배열을 받는다 (dom.js 의 append 와 같은 규칙: null/false 는 건너뛰고 배열은 편다).

import { append } from './dom.js';

export function replace(node, ...children) {
  node.replaceChildren();
  return append(node, children);
}

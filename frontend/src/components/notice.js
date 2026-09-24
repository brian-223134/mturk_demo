// 안내 상자. API 오류는 code 에 따라 제목을 정하고, 501(NOT_IMPLEMENTED)은 "아직 backend 에 없다"는 경고로 보여 준다.

import { el } from './dom.js';

/** kind: info | warning | error | success */
export function notice(kind, title, message, ...extra) {
  return el(
    'div',
    { className: `notice notice-${kind}`, role: kind === 'error' ? 'alert' : 'status' },
    el('div', { className: 'notice-title' }, title),
    message ? el('div', { className: 'notice-message' }, message) : null,
    ...extra,
  );
}

const ERROR_TITLES = {
  NOT_IMPLEMENTED: ['warning', 'Not implemented in the backend yet'],
  NETWORK: ['error', 'Cannot reach the API server'],
  NOT_FOUND: ['warning', 'Not found'],
  INVALID_REQUEST: ['error', 'Invalid request'],
  UNKNOWN: ['error', 'Request failed'],
};

/** ApiError(또는 아무 Error)를 안내 상자로. context 를 주면 제목 앞에 붙는다 (예: "HITs: Not implemented …"). */
export function errorNotice(error, context) {
  const code = error && typeof error.code === 'string' && ERROR_TITLES[error.code] ? error.code : 'UNKNOWN';
  const [kind, title] = ERROR_TITLES[code];
  const message = error instanceof Error ? error.message : String(error);
  const node = notice(kind, context ? `${context}: ${title}` : title, message);
  node.dataset.errorCode = code;
  if (error && typeof error.status === 'number' && error.status > 0) node.dataset.httpStatus = String(error.status);
  return node;
}

export function loading(text = 'Loading…') {
  return el('div', { className: 'loading', role: 'status' }, text);
}

export function muted(text) {
  return el('p', { className: 'muted' }, text);
}

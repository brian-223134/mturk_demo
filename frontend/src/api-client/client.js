// API 클라이언트. 경로 표(routes.js)의 이름으로 부르면 encodeRequest 가 요청을 만들고, 여기서는 fetch 와 오류 봉투만 다룬다.
// 오류는 항상 ApiError { code, message, status } 로 던진다. code 는 backend 의 봉투 { error: { code, message } } 에서 오고,
// 서버에 닿지 못했거나 JSON 이 아닌 응답(nginx 의 502 HTML 등)은 NETWORK 다.

import { AGENT_ROUTES, API_ROUTES, encodeRequest } from './routes.js';

export const BASE_URL = '/api';

const ERROR_CODES = ['NOT_FOUND', 'INVALID_REQUEST', 'NOT_IMPLEMENTED', 'NETWORK', 'UNKNOWN'];
const ROUTES = { ...API_ROUTES, ...AGENT_ROUTES };

export class ApiError extends Error {
  constructor(code, message, status = 0) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

/** error 가 ApiError 이고 code 가 주어진 것 중 하나인지 (code 를 안 주면 ApiError 인지만). */
export function isApiError(error, ...codes) {
  return error instanceof ApiError && (codes.length === 0 || codes.includes(error.code));
}

async function send(method, url, body) {
  const headers = {};
  // FormData 는 브라우저가 boundary 를 붙여 Content-Type 을 정하므로 직접 넣지 않는다
  if (body !== undefined && !(body instanceof FormData)) headers['Content-Type'] = 'application/json';

  let response;
  try {
    response = await fetch(`${BASE_URL}${url}`, { method, headers, body });
  } catch (error) {
    throw new ApiError('NETWORK', `Cannot reach the API server (${BASE_URL}): ${error.message}`);
  }

  if (response.status === 204) return undefined;
  const text = await response.text();
  let payload;
  try {
    payload = text === '' ? undefined : JSON.parse(text);
  } catch {
    // 서버 대신 프록시(nginx)가 답한 경우. 예: backend 가 내려가 있어 502 HTML 이 온다
    throw new ApiError(
      'NETWORK',
      `The API server returned a non-JSON response (HTTP ${response.status}). Is it running?`,
      response.status,
    );
  }
  if (!response.ok) {
    const error = payload && typeof payload === 'object' ? payload.error : undefined;
    const code = ERROR_CODES.includes(error?.code) ? error.code : 'UNKNOWN';
    throw new ApiError(code, error?.message ?? `HTTP ${response.status}`, response.status);
  }
  return payload;
}

/** 경로 표의 이름과 인자 목록(표의 args 순서)으로 부른다. 예: call('listHits', [batchId, { page: 1, pageSize: 25 }]) */
export function call(routeName, args = []) {
  const def = ROUTES[routeName];
  if (!def) throw new Error(`Unknown API route: ${routeName}`);
  const request = encodeRequest(def, args);
  return send(request.method, request.url, request.body);
}

/** 콘솔 REST 를 메서드로 부르는 객체. api.getBatch(id) 처럼 쓴다. 키는 API_ROUTES 와 같다. */
export const api = Object.fromEntries(Object.keys(API_ROUTES).map((name) => [name, (...args) => call(name, args)]));

/** POST /api/agent/jobs (multipart/form-data). 202 면 { job } 을 돌려준다. */
export function createJob(formData) {
  return call('createJob', [formData]);
}

/** job 의 결과 파일을 내려받는 주소. job.files 에 있는 이름만 backend 가 허용한다. */
export function fileUrl(jobId, name) {
  return `${BASE_URL}${encodeRequest(AGENT_ROUTES.getJobFile, [jobId, name]).url}`;
}

/** agent job API. */
export const agent = {
  listModels: () => call('listModels'),
  listJobs: () => call('listJobs'),
  getJob: (id) => call('getJob', [id]),
  createJob,
  fileUrl,
};

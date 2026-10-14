// API 클라이언트. 경로 표(routes.js)의 이름으로 부르면 encodeRequest 가 요청을 만들고, 여기서는 fetch 와 오류 봉투만 다룬다.
// 오류는 항상 ApiError { code, message, status } 로 던진다. code 는 backend 의 봉투 { error: { code, message } } 에서 오고,
// 서버에 닿지 못했거나 JSON 이 아닌 응답(nginx 의 502 HTML 등)은 NETWORK 다.
// 콘솔 REST 나 agent API 가 401(UNAUTHORIZED)이면 세션이 끝난 것이므로 window 에 'auth:required' 이벤트를 보낸다
// (main.js 가 로그인 화면으로 보낸다). 계정 API 의 401(틀린 비밀번호 등)은 화면이 직접 다루므로 이벤트를 보내지 않는다.

import { ACCOUNT_ROUTES, AGENT_ROUTES, API_ROUTES, WORKER_ROUTES, encodeRequest } from './routes.js';

export const BASE_URL = '/api';
export const AUTH_REQUIRED_EVENT = 'auth:required';

const ERROR_CODES = ['NOT_FOUND', 'INVALID_REQUEST', 'UNAUTHORIZED', 'FORBIDDEN', 'NOT_IMPLEMENTED', 'NETWORK', 'UNKNOWN'];
const ROUTES = { ...API_ROUTES, ...AGENT_ROUTES, ...ACCOUNT_ROUTES, ...WORKER_ROUTES };

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

async function send(method, url, body, { notifyAuth = true } = {}) {
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
    if (code === 'UNAUTHORIZED' && notifyAuth && typeof globalThis.dispatchEvent === 'function') {
      globalThis.dispatchEvent(new CustomEvent(AUTH_REQUIRED_EVENT));
    }
    throw new ApiError(code, error?.message ?? `HTTP ${response.status}`, response.status);
  }
  return payload;
}

/** 경로 표의 이름과 인자 목록(표의 args 순서)으로 부른다. 예: call('listHits', [batchId, { page: 1, pageSize: 25 }]) */
export function call(routeName, args = []) {
  const def = ROUTES[routeName];
  if (!def) throw new Error(`Unknown API route: ${routeName}`);
  const request = encodeRequest(def, args);
  return send(request.method, request.url, request.body, { notifyAuth: !(routeName in ACCOUNT_ROUTES) });
}

/** 콘솔 REST 를 메서드로 부르는 객체. api.getBatch(id) 처럼 쓴다. 키는 API_ROUTES 와 같다. */
export const api = Object.fromEntries(Object.keys(API_ROUTES).map((name) => [name, (...args) => call(name, args)]));

/** POST /api/agent/jobs (multipart/form-data). 202 면 { job } 을 돌려준다. */
export function createJob(formData) {
  return call('createJob', [formData]);
}

/** POST /api/agent/job-groups (multipart/form-data, model_configs 를 후보마다 한 번씩). 202 면 { group, jobs } 를 돌려준다. */
export function createJobGroup(formData) {
  return call('createJobGroup', [formData]);
}

/** job 의 결과 파일을 내려받는 주소. job.files 에 있는 이름만 backend 가 허용한다. */
export function fileUrl(jobId, name) {
  return `${BASE_URL}${encodeRequest(AGENT_ROUTES.getJobFile, [jobId, name]).url}`;
}

/** 계정 API (로그인, 가입, 내 계정). */
export const auth = {
  options: () => call('getSignupOptions'),
  signup: (body) => call('signup', [body]),
  login: (email, password) => call('login', [email, password]),
  logout: () => call('logout'),
  me: () => call('getMe'),
};

/** admin 의 사용자와 초대 코드 관리. */
export const admin = {
  listUsers: () => call('listUsers'),
  suspendUser: (id) => call('suspendUser', [id]),
  activateUser: (id) => call('activateUser', [id]),
  listInvitations: () => call('listInvitations'),
  createInvitation: (body) => call('createInvitation', [body]),
  deleteInvitation: (id) => call('deleteInvitation', [id]),
};

/** worker 의 작업 API (HIT 받기, 작업 화면, 제출, 반납, 내 HIT). */
export const worker = {
  listHitGroups: () => call('listHitGroups'),
  acceptHit: (batchId) => call('acceptHit', [batchId]),
  listMyAssignments: () => call('listMyAssignments'),
  getMyAssignment: (id) => call('getMyAssignment', [id]),
  submitAssignment: (id, answers) => call('submitAssignment', [id, answers]),
  returnAssignment: (id) => call('returnAssignment', [id]),
};

/** agent job API. */
export const agent = {
  exampleRawUrl: `${BASE_URL}${AGENT_ROUTES.getExampleRaw.path}`,
  listModels: () => call('listModels'),
  listJobs: () => call('listJobs'),
  getJob: (id) => call('getJob', [id]),
  getJobInputs: (id) => call('getJobInputs', [id]),
  reviewJob: (id, body) => call('reviewJob', [id, body]),
  chooseCandidate: (groupId, jobId) => call('chooseCandidate', [groupId, jobId]),
  createJob,
  createJobGroup,
  fileUrl,
};

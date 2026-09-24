// Api 인터페이스의 http 구현. 메서드마다 routes.ts의 경로로 요청을 보낸다.
// 지금은 mock API 서버(server/)를 부르고, 연동 단계에서는 같은 경로를 구현한 실제 백엔드를 부른다.

import type { Api } from '../client';
import type { MockTools } from '../mock/tools';
import { ApiError, type ApiErrorCode } from '../types';
import { API_ROUTES, MOCK_ROUTES, encodeRequest, type RouteDef } from './routes';

const ERROR_CODES: readonly ApiErrorCode[] = ['NOT_FOUND', 'INVALID_REQUEST', 'NOT_IMPLEMENTED', 'NETWORK', 'UNKNOWN'];

async function call(baseUrl: string, def: RouteDef, args: readonly unknown[]): Promise<unknown> {
  const request = encodeRequest(def, args);
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${request.url}`, {
      method: request.method,
      headers: request.body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: request.body,
    });
  } catch (error) {
    throw new ApiError('NETWORK', `Cannot reach the API server (${baseUrl}): ${(error as Error).message}`);
  }

  if (response.status === 204) return undefined;
  const text = await response.text();
  let payload: unknown;
  try {
    payload = text === '' ? undefined : JSON.parse(text);
  } catch {
    // 서버 대신 프록시나 nginx가 답한 경우 (예: 서버가 내려가 있어 502 HTML이 온다)
    throw new ApiError('NETWORK', `The API server returned a non-JSON response (HTTP ${response.status}). Is it running?`);
  }
  if (!response.ok) {
    const error = (payload as { error?: { code?: string; message?: string } } | undefined)?.error;
    const code = ERROR_CODES.find((c) => c === error?.code) ?? 'UNKNOWN';
    throw new ApiError(code, error?.message ?? `HTTP ${response.status}`);
  }
  return payload;
}

function bind<T extends object>(baseUrl: string, routes: Record<keyof T, RouteDef>): T {
  const entries = Object.entries<RouteDef>(routes).map(([name, def]) => [
    name,
    (...args: unknown[]) => call(baseUrl, def, args),
  ]);
  return Object.fromEntries(entries) as T;
}

export function createHttpClient(baseUrl: string): { api: Api; mockTools: MockTools } {
  const base = baseUrl.replace(/\/+$/, '');
  return { api: bind<Api>(base, API_ROUTES), mockTools: bind<MockTools>(base, MOCK_ROUTES) };
}

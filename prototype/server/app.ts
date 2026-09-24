// mock API 서버의 HTTP 처리. 경로 표(src/api/http/routes.ts)의 각 경로를 같은 이름의 핸들러에 연결한다.
// 핸들러와 계산 로직은 브라우저 mock 모드와 같은 코드다 (src/api/mock, src/domain). 여기에는 HTTP만 있다.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Api } from '../src/api/client';
import { API_ROUTES, MOCK_ROUTES, decodeArgs, type RouteDef } from '../src/api/http/routes';
import type { MockTools } from '../src/api/mock/tools';
import { ApiError, type ApiErrorCode } from '../src/api/types';

export const API_PREFIX = '/api';
const MAX_BODY_BYTES = 256 * 1024 * 1024; // CSV 셀 하나가 100KB를 넘을 수 있다 (명세 9장)

const STATUS: Record<ApiErrorCode, number> = {
  NOT_FOUND: 404,
  INVALID_REQUEST: 400,
  NOT_IMPLEMENTED: 501,
  NETWORK: 502,
  UNKNOWN: 500,
};

interface CompiledRoute {
  def: RouteDef;
  pattern: RegExp;
  invoke: (args: unknown[]) => Promise<unknown>;
}

function compile(
  routes: Record<string, RouteDef>,
  target: Record<string, (...args: never[]) => Promise<unknown>>,
): CompiledRoute[] {
  return Object.entries(routes).map(([name, def]) => ({
    def,
    pattern: new RegExp(`^${def.path.replace(/:([A-Za-z]+)/g, '(?<$1>[^/]+)')}$`),
    invoke: (args) => (target[name] as (...a: unknown[]) => Promise<unknown>)(...args),
  }));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new ApiError('INVALID_REQUEST', 'Request body is too large.');
    chunks.push(chunk);
  }
  if (size === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
  } catch {
    throw new ApiError('INVALID_REQUEST', 'Request body is not valid JSON.');
  }
}

function send(res: ServerResponse, status: number, payload?: unknown): void {
  if (payload === undefined) {
    res.writeHead(status === 200 ? 204 : status).end();
    return;
  }
  const text = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }).end(text);
}

export function createRequestHandler(api: Api, tools: MockTools, log: (line: string) => void = console.log) {
  const routes = [
    ...compile(API_ROUTES, api as unknown as Record<string, (...args: never[]) => Promise<unknown>>),
    ...compile(MOCK_ROUTES, tools as unknown as Record<string, (...args: never[]) => Promise<unknown>>),
  ];

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const started = Date.now();
    const url = new URL(req.url ?? '/', 'http://localhost');
    let status = 200;
    try {
      if (!url.pathname.startsWith(`${API_PREFIX}/`)) throw new ApiError('NOT_FOUND', `No such path: ${url.pathname}`);
      const path = url.pathname.slice(API_PREFIX.length);

      if (req.method === 'GET' && path === '/health') {
        send(res, 200, { status: 'ok', ...(await tools.getInfo()) });
        return;
      }

      let match: RegExpExecArray | null = null;
      const route = routes.find((r) => r.def.method === req.method && (match = r.pattern.exec(path)) !== null);
      if (!route || !match) throw new ApiError('NOT_FOUND', `No such route: ${req.method} ${url.pathname}`);

      const params = Object.fromEntries(
        Object.entries((match as RegExpExecArray).groups ?? {}).map(([k, v]) => [k, decodeURIComponent(v)]),
      );
      const body = route.def.method === 'POST' || route.def.method === 'PUT' ? await readBody(req) : undefined;
      let args: unknown[];
      try {
        args = decodeArgs(route.def, { params, query: url.searchParams, body });
      } catch {
        throw new ApiError('INVALID_REQUEST', 'Malformed query string (filters must be JSON).');
      }
      send(res, 200, await route.invoke(args));
    } catch (error) {
      const apiError = error instanceof ApiError ? error : null;
      status = apiError ? STATUS[apiError.code] : 500;
      if (!apiError) console.error(error);
      send(res, status, {
        error: { code: apiError?.code ?? 'UNKNOWN', message: error instanceof Error ? error.message : String(error) },
      });
    } finally {
      log(`${req.method} ${url.pathname} → ${res.statusCode || status} (${Date.now() - started} ms)`);
    }
  };
}

// 라우터의 순수한 부분: 경로 패턴을 정규식으로 바꾸고(compilePattern), 현재 경로에 맞는 route 를 찾는다(matchRoute).
// window 와 document 를 쓰지 않으므로 Node 의 테스트(tests/router.test.js)에서 그대로 import 할 수 있다.
// route 등록과 이동(pushState, popstate, 링크 가로채기)은 router.js 에 있다.

/**
 * '/manage/:batchId/:tab' → { regex, keys: ['batchId', 'tab'] }.
 * `:이름` 조각은 / 를 뺀 한 조각과 맞고, 나머지 조각은 글자 그대로 맞는다. 끝의 / 하나는 있어도 된다.
 */
export function compilePattern(pattern) {
  const keys = [];
  const source = pattern
    .split('/')
    .map((segment) => {
      if (segment.startsWith(':')) {
        keys.push(segment.slice(1));
        return '([^/]+)';
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { regex: new RegExp(`^${source}/?$`), keys };
}

/**
 * 등록 순서대로 처음 맞는 route 를 { ...route, params } 로 돌려준다. 없으면 null.
 * routes 의 각 항목은 compilePattern 의 결과(regex, keys)에 handler, meta 를 더한 것이다. params 값은 decodeURIComponent 를 거친다.
 */
export function matchRoute(routes, pathname) {
  for (const r of routes) {
    const m = r.regex.exec(pathname);
    if (!m) continue;
    const params = {};
    r.keys.forEach((key, i) => {
      params[key] = decodeURIComponent(m[i + 1]);
    });
    return { ...r, params };
  }
  return null;
}

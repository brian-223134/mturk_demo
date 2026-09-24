// 표의 여러 행 선택. 페이지를 넘겨도 유지되도록 행 자체를 키와 함께 들고 있는다 (버튼 활성화에 행의 상태가 필요하다).
// DOM 을 쓰지 않으므로 Node 에서 테스트한다.

export function createSelection(keyOf) {
  const items = new Map();
  const listeners = new Set();
  const notify = () => {
    for (const fn of listeners) fn(api);
  };
  const api = {
    get size() {
      return items.size;
    },
    has: (row) => items.has(keyOf(row)),
    hasKey: (key) => items.has(key),
    values: () => [...items.values()],
    keys: () => [...items.keys()],
    /** checked 를 안 주면 뒤집는다 */
    toggle(row, checked) {
      const key = keyOf(row);
      const next = checked === undefined ? !items.has(key) : Boolean(checked);
      if (next) items.set(key, row);
      else items.delete(key);
      notify();
    },
    add(rows) {
      for (const row of rows) items.set(keyOf(row), row);
      notify();
    },
    remove(rows) {
      for (const row of rows) items.delete(keyOf(row));
      notify();
    },
    removeKeys(keys) {
      for (const key of keys) items.delete(key);
      notify();
    },
    /** 이 행들을 모두 선택하거나(checked) 모두 해제한다 (페이지 단위 select all) */
    setAll(rows, checked) {
      for (const row of rows) {
        if (checked) items.set(keyOf(row), row);
        else items.delete(keyOf(row));
      }
      notify();
    },
    /** 이 행들의 선택만 반전한다. 다른 페이지의 선택은 그대로 둔다 */
    invert(rows) {
      for (const row of rows) {
        const key = keyOf(row);
        if (items.has(key)) items.delete(key);
        else items.set(key, row);
      }
      notify();
    },
    replace(rows) {
      items.clear();
      for (const row of rows) items.set(keyOf(row), row);
      notify();
    },
    clear() {
      if (items.size === 0) return;
      items.clear();
      notify();
    },
    allSelected: (rows) => rows.length > 0 && rows.every((row) => items.has(keyOf(row))),
    someSelected: (rows) => rows.some((row) => items.has(keyOf(row))),
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  return api;
}

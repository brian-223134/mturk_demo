// Create 마법사의 임시 저장. "진행 중인 입력은 브라우저에 임시 저장되어 새로고침해도 유지된다."
// CSV 가 수 MB 일 수 있어 localStorage 가 아니라 IndexedDB 에 둔다. 저장소를 못 써도 마법사는 동작해야 하므로 여기의 함수는 오류를 던지지 않는다.
// prototype/src/features/create/draft.ts 를 옮겼다. 순수한 부분(emptyDraft, serializeDraft, restoreDraft)과 저장소를 주입받는
// createDraftStorage 는 Node 에서 테스트하고, IndexedDB 는 indexedDbStore 에만 있다.

import { defaultSettings } from './settings.js';

export const STEP_TITLES = ['Template', 'Data', 'Settings', 'Preview & Cost', 'Publish'];
export const LAST_STEP = STEP_TITLES.length - 1;
export const TEMPLATE_MODES = ['saved', 'new', 'generate'];

export function emptyDraft() {
  return {
    step: 0, // 0부터
    templateMode: 'saved', // 'saved' | 'new' | 'generate'
    templateId: null,
    editor: { id: null, name: '', html: '' }, // 저장된 템플릿을 고치는 중이면 id, 새로 만드는 중이면 null
    data: null, // CsvData { fileName, columns, rows, hadBom, warnings }
    settings: defaultSettings(),
    previewRow: 0, // 0부터
    batchName: '', // 비어 있으면 Publish 단계가 "<템플릿 이름> <날짜>" 를 제안한다
    answerSchema: [], // 미리보기에서 읽어 낸 문항 목록. 게시할 때 answerSchema 로 보낸다
  };
}

export const DRAFT_KEY = 'mturk-console:create-draft';
// 폼에 글자를 칠 때마다 수 MB 의 CSV 를 다시 쓰지 않게 CSV 는 다른 키에 두고, 바뀌었을 때만 쓴다
export const DRAFT_CSV_KEY = 'mturk-console:create-draft:csv';
export const DRAFT_VERSION = 1;
const LOAD_TIMEOUT_MS = 3000;
const DB_NAME = 'mturk-console-frontend';
const STORE_NAME = 'kv';

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCsvData(value) {
  return isObject(value) && Array.isArray(value.columns) && Array.isArray(value.rows) && typeof value.fileName === 'string';
}

/** 저장할 모양으로 나눈다: CSV 를 뺀 본문(stored)과 CSV(csv). */
export function serializeDraft(draft, savedAt = new Date().toISOString()) {
  const { data, ...rest } = draft;
  return { stored: { ...rest, version: DRAFT_VERSION, savedAt, hasData: data !== null && data !== undefined }, csv: data ?? null };
}

/** 저장본을 draft 로 되돌린다. 버전이 다르거나 모양이 아니면 null. 나중에 추가된 설정 항목이 저장본에 없어도 기본값으로 채워진다. */
export function restoreDraft(stored, csv) {
  if (!isObject(stored) || stored.version !== DRAFT_VERSION) return null;
  const { version: _version, savedAt, hasData, ...rest } = stored;
  const base = emptyDraft();
  const data = hasData && isCsvData(csv) ? { ...csv, hadBom: Boolean(csv.hadBom), warnings: Array.isArray(csv.warnings) ? csv.warnings : [] } : null;
  const draft = {
    ...base,
    ...rest,
    editor: { ...base.editor, ...(isObject(rest.editor) ? rest.editor : {}) },
    settings: { ...base.settings, ...(isObject(rest.settings) ? rest.settings : {}) },
    answerSchema: Array.isArray(rest.answerSchema) ? rest.answerSchema : [],
    data,
  };
  draft.step = Math.min(Math.max(0, Math.trunc(Number(draft.step)) || 0), LAST_STEP);
  if (!TEMPLATE_MODES.includes(draft.templateMode)) draft.templateMode = 'saved';
  if (typeof draft.templateId !== 'string') draft.templateId = null;
  if (typeof draft.batchName !== 'string') draft.batchName = '';
  draft.previewRow = Math.max(0, Math.trunc(Number(draft.previewRow)) || 0);
  return { draft, savedAt: typeof savedAt === 'string' ? savedAt : '' };
}

/**
 * store: { get(key) → Promise<value|undefined>, set(key, value) → Promise, del(keys) → Promise }.
 * 저장과 삭제가 섞이지 않게 한 줄로 세우고, 저장소 오류는 한 번만 console.warn 한다.
 */
export function createDraftStorage(store, { timeoutMs = LOAD_TIMEOUT_MS } = {}) {
  let queue = Promise.resolve();
  let storedCsv; // 마지막으로 저장한 CSV. 참조가 같으면 다시 쓰지 않는다
  let warned = false;

  function warnOnce(error) {
    if (!warned) console.warn('[create] The wizard draft cannot use the browser storage. The wizard still works, but a reload loses the input.', error);
    warned = true;
  }

  function enqueue(task) {
    queue = queue.then(task).catch((error) => {
      warnOnce(error);
      storedCsv = undefined;
    });
    return queue;
  }

  async function load() {
    try {
      // 일부 환경에서는 IndexedDB 요청이 오류도 없이 끝나지 않는다
      const [stored, csv] = await Promise.race([
        Promise.all([store.get(DRAFT_KEY), store.get(DRAFT_CSV_KEY)]),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`The draft storage did not respond within ${timeoutMs} ms`)), timeoutMs)),
      ]);
      return restoreDraft(stored, csv);
    } catch (error) {
      warnOnce(error);
      return null;
    }
  }

  /** 화면에 올린 CSV 가 이미 저장소에 있는 것임을 알린다 (복원 직후에 같은 CSV 를 다시 쓰지 않게). */
  function markCsvStored(data) {
    storedCsv = data;
  }

  function save(draft) {
    return enqueue(async () => {
      const { stored, csv } = serializeDraft(draft);
      if (storedCsv !== csv) {
        if (csv) await store.set(DRAFT_CSV_KEY, csv);
        else await store.del([DRAFT_CSV_KEY]);
        storedCsv = csv;
      }
      await store.set(DRAFT_KEY, stored);
    });
  }

  function clear() {
    return enqueue(async () => {
      storedCsv = undefined;
      await store.del([DRAFT_KEY, DRAFT_CSV_KEY]);
    });
  }

  return { load, save, clear, markCsvStored };
}

/** IndexedDB 의 object store 하나를 key-value 로 쓰는 store. 열기는 처음 쓸 때 한다. */
export function indexedDbStore() {
  let dbPromise = null;

  function open() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        if (typeof indexedDB === 'undefined') {
          reject(new Error('IndexedDB is not available'));
          return;
        }
        let request;
        try {
          request = indexedDB.open(DB_NAME, 1);
        } catch (error) {
          reject(error);
          return;
        }
        request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
        request.onblocked = () => reject(new Error('IndexedDB open is blocked'));
      }).catch((error) => {
        dbPromise = null;
        throw error;
      });
    }
    return dbPromise;
  }

  async function run(mode, action) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, mode);
      const objectStore = tx.objectStore(STORE_NAME);
      let result;
      try {
        result = action(objectStore);
      } catch (error) {
        reject(error);
        return;
      }
      tx.oncomplete = () => resolve(result && 'result' in result ? result.result : undefined);
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    });
  }

  return {
    get: (key) => run('readonly', (s) => s.get(key)),
    set: (key, value) => run('readwrite', (s) => s.put(value, key)),
    del: (keys) =>
      run('readwrite', (s) => {
        for (const key of keys) s.delete(key);
        return undefined;
      }),
  };
}

let defaultStorage = null;

/** 화면이 쓰는 저장소 (IndexedDB). 처음 부를 때 만든다. */
export function draftStorage() {
  if (!defaultStorage) defaultStorage = createDraftStorage(indexedDbStore());
  return defaultStorage;
}

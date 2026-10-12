// Project 편집기(Enter Properties, Design Layout, Preview and Finish)의 임시 저장과 저장 요청. 저장하지 않은 편집은 Project 마다
// 브라우저(IndexedDB)에 남아 새로고침하거나 다른 탭에 다녀와도 이어서 고칠 수 있다. 저장(Save, Finish)하면 지운다.
// 새 Project 는 key 'new' 하나에 둔다 (갤러리에서 starter 를 고르면 덮어쓴다).
//
// 서버의 템플릿 레코드가 MTurk 의 Project 다: name(내부용 이름), html(layout), properties(Enter Properties 의 폼 값),
// sampleRow(Design Layout 미리보기의 표본 행). properties 와 sampleRow 는 backend 의 saveTemplate 이 객체인지만 본다.

import { sharedStore } from './draft.js';
import { settingsFromProperties } from './settings.js';
import { extractPlaceholders } from './template.js';

export const PROJECT_DRAFT_PREFIX = 'mturk-console:project-draft:';
export const PROJECT_DRAFT_VERSION = 1;
export const NEW_PROJECT = 'new';
const LOAD_TIMEOUT_MS = 3000;

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringRecord(value) {
  const out = {};
  if (!isObject(value)) return out;
  for (const [key, cell] of Object.entries(value)) if (typeof cell === 'string') out[key] = cell;
  return out;
}

export function emptyProjectDraft() {
  return { projectId: null, name: '', html: '', settings: settingsFromProperties(null), sampleRow: {}, starterId: null };
}

/** 저장된 Project(템플릿 레코드)를 편집할 값으로. */
export function projectDraftFromTemplate(template) {
  return {
    projectId: template.id,
    name: template.name,
    html: template.html,
    settings: settingsFromProperties(template.properties),
    sampleRow: stringRecord(template.sampleRow),
    starterId: null,
  };
}

/** 갤러리의 starter 로 새 Project 를 시작한다. html 은 starter 파일의 내용이다. */
export function projectDraftFromStarter(starter, html) {
  return {
    projectId: null,
    name: starter.title,
    html,
    settings: settingsFromProperties(starter.properties),
    sampleRow: { ...starter.sampleRow },
    starterId: starter.id,
  };
}

/** 키 순서와 상관없이 같은 값이면 같은 글. */
export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

/** 표본 행에서 layout 이 쓰는 컬럼만 남긴다 (지운 변수의 값이 남지 않게). */
export function sampleFor(html, sampleRow) {
  const out = {};
  for (const name of extractPlaceholders(html)) out[name] = typeof sampleRow?.[name] === 'string' ? sampleRow[name] : '';
  return out;
}

/** 편집 중인 값이 저장본과 같은지. 표본 행은 layout 이 쓰는 컬럼만 비교한다. */
export function sameAsSaved(draft, template) {
  if (!template) return false;
  return (
    draft.name.trim() === template.name &&
    draft.html === template.html &&
    stableStringify(draft.settings) === stableStringify(settingsFromProperties(template.properties)) &&
    stableStringify(sampleFor(draft.html, draft.sampleRow)) === stableStringify(sampleFor(template.html, stringRecord(template.sampleRow)))
  );
}

/** POST /api/templates 의 body. */
export function toSaveRequest(draft) {
  return {
    ...(draft.projectId ? { id: draft.projectId } : {}),
    name: draft.name.trim(),
    html: draft.html,
    properties: draft.settings,
    sampleRow: sampleFor(draft.html, draft.sampleRow),
  };
}

/** 저장본을 되돌린다. 모양이 아니면 null. */
export function restoreProjectDraft(stored) {
  if (!isObject(stored) || stored.version !== PROJECT_DRAFT_VERSION) return null;
  if (typeof stored.html !== 'string' || typeof stored.name !== 'string') return null;
  return {
    draft: {
      projectId: typeof stored.projectId === 'string' ? stored.projectId : null,
      name: stored.name,
      html: stored.html,
      settings: settingsFromProperties(stored.settings),
      sampleRow: stringRecord(stored.sampleRow),
      starterId: typeof stored.starterId === 'string' ? stored.starterId : null,
    },
    savedAt: typeof stored.savedAt === 'string' ? stored.savedAt : '',
  };
}

/**
 * store 는 lib/draft.js 의 indexedDbStore 와 같은 { get, set, del }. 오류를 던지지 않는다 (편집기는 저장소 없이도 동작한다).
 * 같은 탭 안에서는 메모리의 사본을 먼저 쓴다: 편집기의 탭을 오갈 때 IndexedDB 에 아직 쓰이지 않은 편집을 잃지 않게 하려는 것이다.
 */
export function createProjectDraftStorage(store, { timeoutMs = LOAD_TIMEOUT_MS } = {}) {
  const memory = new Map();
  let warned = false;
  const warnOnce = (error) => {
    if (!warned) console.warn('[create] Unsaved project edits cannot be kept in the browser storage.', error);
    warned = true;
  };
  let queue = Promise.resolve();
  const enqueue = (task) => {
    queue = queue.then(task).catch(warnOnce);
    return queue;
  };
  return {
    async load(key) {
      if (memory.has(key)) return restoreProjectDraft(memory.get(key));
      try {
        const stored = await Promise.race([
          store.get(PROJECT_DRAFT_PREFIX + key),
          new Promise((_, reject) => setTimeout(() => reject(new Error(`The draft storage did not respond within ${timeoutMs} ms`)), timeoutMs)),
        ]);
        return restoreProjectDraft(stored);
      } catch (error) {
        warnOnce(error);
        return null;
      }
    },
    save(key, draft, savedAt = new Date().toISOString()) {
      const stored = { ...draft, version: PROJECT_DRAFT_VERSION, savedAt };
      memory.set(key, stored);
      return enqueue(() => store.set(PROJECT_DRAFT_PREFIX + key, stored));
    },
    clear(key) {
      memory.delete(key);
      return enqueue(() => store.del([PROJECT_DRAFT_PREFIX + key]));
    },
  };
}

let defaultStorage = null;

export function projectDraftStorage() {
  if (!defaultStorage) defaultStorage = createProjectDraftStorage(sharedStore());
  return defaultStorage;
}

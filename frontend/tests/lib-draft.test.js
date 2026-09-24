// lib/draft.js: 임시 저장의 순수한 부분과, 가짜 store 를 넣은 createDraftStorage.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DRAFT_CSV_KEY,
  DRAFT_KEY,
  DRAFT_VERSION,
  LAST_STEP,
  STEP_TITLES,
  createDraftStorage,
  emptyDraft,
  restoreDraft,
  serializeDraft,
} from '../src/lib/draft.js';

const csv = { fileName: 'data.csv', columns: ['a'], rows: [{ a: '1' }], hadBom: false, warnings: [] };

function memoryStore() {
  const map = new Map();
  const log = [];
  return {
    map,
    log,
    get: async (key) => {
      log.push(['get', key]);
      return map.get(key);
    },
    set: async (key, value) => {
      log.push(['set', key]);
      map.set(key, value);
    },
    del: async (keys) => {
      log.push(['del', ...keys]);
      for (const key of keys) map.delete(key);
    },
  };
}

describe('emptyDraft / steps', () => {
  it('has five steps and starts at Template with the default settings', () => {
    assert.deepEqual(STEP_TITLES, ['Template', 'Data', 'Settings', 'Preview & Cost', 'Publish']);
    assert.equal(LAST_STEP, 4);
    const draft = emptyDraft();
    assert.equal(draft.step, 0);
    assert.equal(draft.templateMode, 'saved');
    assert.equal(draft.templateId, null);
    assert.equal(draft.data, null);
    assert.equal(draft.settings.Reward, '0.10');
    assert.deepEqual(draft.answerSchema, []);
  });
});

describe('serializeDraft / restoreDraft', () => {
  it('splits the CSV from the rest and restores the same draft', () => {
    const draft = { ...emptyDraft(), step: 2, templateId: 'tpl-1', data: csv, batchName: 'b' };
    const { stored, csv: storedCsv } = serializeDraft(draft, '2026-09-25T00:00:00.000Z');
    assert.equal(stored.version, DRAFT_VERSION);
    assert.equal(stored.hasData, true);
    assert.equal(stored.savedAt, '2026-09-25T00:00:00.000Z');
    assert.ok(!('data' in stored));
    assert.equal(storedCsv, csv);
    const restored = restoreDraft(stored, storedCsv);
    assert.deepEqual(restored.draft, draft);
    assert.equal(restored.savedAt, '2026-09-25T00:00:00.000Z');
  });

  it('returns null for a missing or foreign version, and fills settings added later with defaults', () => {
    assert.equal(restoreDraft(undefined, undefined), null);
    assert.equal(restoreDraft({ version: 99 }, undefined), null);
    const restored = restoreDraft({ version: DRAFT_VERSION, step: 7, settings: { Title: 'X' }, templateMode: 'weird', hasData: true }, { junk: true });
    assert.equal(restored.draft.step, LAST_STEP);
    assert.equal(restored.draft.templateMode, 'saved');
    assert.equal(restored.draft.settings.Title, 'X');
    assert.equal(restored.draft.settings.Reward, '0.10');
    assert.equal(restored.draft.data, null); // CSV 모양이 아니면 버린다
    assert.equal(restored.savedAt, '');
  });
});

describe('createDraftStorage', () => {
  it('saves the CSV only when it changes and clears both keys', async () => {
    const store = memoryStore();
    const storage = createDraftStorage(store);
    const draft = { ...emptyDraft(), data: csv };
    await storage.save(draft);
    await storage.save({ ...draft, step: 1 });
    assert.deepEqual(store.log, [
      ['set', DRAFT_CSV_KEY],
      ['set', DRAFT_KEY],
      ['set', DRAFT_KEY],
    ]);
    const loaded = await storage.load();
    assert.equal(loaded.draft.step, 1);
    assert.deepEqual(loaded.draft.data, csv);

    await storage.save({ ...draft, data: null });
    assert.deepEqual(store.log.at(-2), ['del', DRAFT_CSV_KEY]);

    await storage.clear();
    assert.equal(store.map.size, 0);
    assert.equal(await storage.load(), null);
  });

  it('markCsvStored skips rewriting the CSV that was just restored', async () => {
    const store = memoryStore();
    const storage = createDraftStorage(store);
    storage.markCsvStored(csv);
    await storage.save({ ...emptyDraft(), data: csv });
    assert.deepEqual(store.log, [['set', DRAFT_KEY]]);
  });

  it('never throws: a broken store makes load return null and save resolve', async () => {
    const original = console.warn;
    const warnings = [];
    console.warn = (...args) => warnings.push(args[0]);
    try {
      const broken = {
        get: async () => {
          throw new Error('no storage');
        },
        set: async () => {
          throw new Error('no storage');
        },
        del: async () => {
          throw new Error('no storage');
        },
      };
      const storage = createDraftStorage(broken);
      assert.equal(await storage.load(), null);
      await storage.save(emptyDraft());
      await storage.clear();
      assert.equal(warnings.length, 1); // 한 번만 알린다
    } finally {
      console.warn = original;
    }
  });

  it('gives up loading when the store never answers', async () => {
    const original = console.warn;
    console.warn = () => {};
    try {
      const hanging = { get: () => new Promise(() => {}), set: async () => {}, del: async () => {} };
      const storage = createDraftStorage(hanging, { timeoutMs: 20 });
      assert.equal(await storage.load(), null);
    } finally {
      console.warn = original;
    }
  });
});

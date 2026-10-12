// lib/project-draft.js: Project 편집기의 임시 저장과 저장 요청.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  NEW_PROJECT,
  PROJECT_DRAFT_PREFIX,
  createProjectDraftStorage,
  emptyProjectDraft,
  projectDraftFromStarter,
  projectDraftFromTemplate,
  restoreProjectDraft,
  sameAsSaved,
  sampleFor,
  stableStringify,
  toSaveRequest,
} from '../src/lib/project-draft.js';
import { DEFAULT_SETTINGS } from '../src/lib/settings.js';

const HTML = '<p>${query}</p><p>${passage}</p>';
const template = {
  id: 'tpl-a',
  name: 'Relevance',
  html: HTML,
  placeholders: ['query', 'passage'],
  properties: { Title: 'Judge', Reward: '0.05', MaxAssignments: 3 },
  sampleRow: { query: 'q', passage: 'p', old: 'left over' },
};

function memoryStore() {
  const map = new Map();
  return {
    map,
    get: async (key) => map.get(key),
    set: async (key, value) => void map.set(key, value),
    del: async (keys) => keys.forEach((key) => map.delete(key)),
  };
}

describe('project drafts', () => {
  it('from a saved template: properties become form values with defaults filled in', () => {
    const draft = projectDraftFromTemplate(template);
    assert.equal(draft.projectId, 'tpl-a');
    assert.equal(draft.settings.Title, 'Judge');
    assert.equal(draft.settings.Reward, '0.05');
    assert.equal(draft.settings.durationMinutes, DEFAULT_SETTINGS.durationMinutes);
    assert.deepEqual(draft.sampleRow, template.sampleRow);
  });

  it('from a starter: no id yet, the starter values are copied', () => {
    const starter = { id: 's', title: 'Starter', properties: { Title: 'T' }, sampleRow: { query: 'x' } };
    const draft = projectDraftFromStarter(starter, HTML);
    assert.equal(draft.projectId, null);
    assert.equal(draft.name, 'Starter');
    assert.equal(draft.starterId, 's');
    draft.sampleRow.query = 'changed';
    assert.equal(starter.sampleRow.query, 'x');
  });

  it('sampleFor keeps only the variables the layout reads', () => {
    assert.deepEqual(sampleFor(HTML, { query: 'q', other: 'o' }), { query: 'q', passage: '' });
  });

  it('sameAsSaved ignores key order and sample values of removed variables', () => {
    const draft = projectDraftFromTemplate(template);
    assert.equal(sameAsSaved(draft, template), true);
    assert.equal(sameAsSaved({ ...draft, sampleRow: { passage: 'p', query: 'q' } }, template), true);
    assert.equal(sameAsSaved({ ...draft, name: ' Relevance ' }, template), true);
    assert.equal(sameAsSaved({ ...draft, html: `${HTML} ` }, template), false);
    assert.equal(sameAsSaved({ ...draft, settings: { ...draft.settings, Reward: '0.06' } }, template), false);
    assert.equal(sameAsSaved(draft, null), false);
    assert.equal(stableStringify({ b: 1, a: [2, { d: 3, c: 4 }] }), '{"a":[2,{"c":4,"d":3}],"b":1}');
  });

  it('toSaveRequest: trims the name, sends properties and the pruned sample row', () => {
    const request = toSaveRequest({ ...projectDraftFromTemplate(template), name: '  Renamed ' });
    assert.equal(request.id, 'tpl-a');
    assert.equal(request.name, 'Renamed');
    assert.deepEqual(request.sampleRow, { query: 'q', passage: 'p' });
    assert.equal(request.properties.Title, 'Judge');
    assert.ok(!('id' in toSaveRequest(emptyProjectDraft())));
  });

  it('restoreProjectDraft rejects other versions and broken values', () => {
    assert.equal(restoreProjectDraft(undefined), null);
    assert.equal(restoreProjectDraft({ version: 99, name: 'x', html: '' }), null);
    assert.equal(restoreProjectDraft({ version: 1, name: 'x' }), null);
    const restored = restoreProjectDraft({ version: 1, name: 'x', html: 'h', settings: { Reward: 5, Title: 'ok' }, sampleRow: { a: 'b', n: 1 }, savedAt: 'now' });
    assert.equal(restored.draft.settings.Reward, DEFAULT_SETTINGS.Reward); // 종류가 다른 값은 기본값
    assert.equal(restored.draft.settings.Title, 'ok');
    assert.deepEqual(restored.draft.sampleRow, { a: 'b' });
    assert.equal(restored.savedAt, 'now');
  });

  it('storage: keys per project, memory first, clear removes both', async () => {
    const store = memoryStore();
    const storage = createProjectDraftStorage(store);
    const draft = projectDraftFromTemplate(template);
    await storage.save('tpl-a', draft, 'at');
    await storage.save(NEW_PROJECT, emptyProjectDraft(), 'at');
    assert.deepEqual([...store.map.keys()].sort(), [PROJECT_DRAFT_PREFIX + NEW_PROJECT, PROJECT_DRAFT_PREFIX + 'tpl-a'].sort());
    assert.equal((await storage.load('tpl-a')).draft.name, 'Relevance');
    // 다른 탭(새 저장소)은 IndexedDB 에서 읽는다
    assert.equal((await createProjectDraftStorage(store).load('tpl-a')).draft.name, 'Relevance');
    await storage.clear('tpl-a');
    assert.equal(await storage.load('tpl-a'), null);
    assert.equal(store.map.has(PROJECT_DRAFT_PREFIX + 'tpl-a'), false);
  });
});

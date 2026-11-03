// lib/rough-designs.js: New Project 의 rough design 과 task 종류의 모든 조합이 바로 쓸 수 있는 상태인지 본다.
// 고르기 → 미리보기 → Project 저장 요청 → Upload JSON 까지의 흐름을 DOM 없이 따라간다.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

import { checkData } from '../src/lib/data-check.js';
import { formatJsonTemplate, parseJsonData } from '../src/lib/json-data.js';
import { hasLayoutErrors, lintLayout } from '../src/lib/layout-lint.js';
import { toSaveRequest } from '../src/lib/project-draft.js';
import { ROUGH_DESIGNS, SLOT_LABELS, TASK_TYPES, buildDesignTemplate, designDataPath, designPath, findSameProject, roughDesignById, taskTypeById } from '../src/lib/rough-designs.js';
import { DEFAULT_SETTINGS, validateProperties } from '../src/lib/settings.js';
import { extractPlaceholders, renderTemplate } from '../src/lib/template.js';

const require = createRequire(import.meta.url);
const { core } = require('../src/elements/ann-elements.js');
const SRC = new URL('../src/', import.meta.url);

describe('rough design 목록', () => {
  it('가안 5개와 task 종류 3개가 있고 id 로 찾는다', () => {
    assert.deepEqual(ROUGH_DESIGNS.map((d) => d.letter), ['A', 'B', 'C', 'D', 'E']);
    assert.deepEqual(TASK_TYPES.map((t) => t.id), ['vision', 'video', 'text']);
    assert.equal(roughDesignById('stacked').letter, 'B');
    assert.equal(roughDesignById('nope'), null);
    assert.equal(taskTypeById('video').title, 'Video');
    assert.equal(taskTypeById(undefined), null);
  });

  it('LLM 에 넘길 수 있게 JSON 으로 그대로 옮겨진다', () => {
    assert.deepEqual(JSON.parse(JSON.stringify(ROUGH_DESIGNS)), ROUGH_DESIGNS);
  });

  it('칸마다 이름이 있고, 칸이 둘 이상인 줄은 비율이 칸 수와 맞는다', () => {
    for (const design of ROUGH_DESIGNS) {
      for (const row of design.rows) {
        for (const slot of row.slots) assert.ok(SLOT_LABELS[slot], `${design.id}: ${slot}`);
        if (row.slots.length > 1) assert.equal(row.columns.split(' ').length, row.slots.length, design.id);
      }
    }
  });

  it('스케치의 A, B 배치를 따른다', () => {
    assert.deepEqual(roughDesignById('side-by-side').rows.map((r) => r.slots), [['data', 'choice'], ['free-text']]);
    assert.deepEqual(roughDesignById('stacked').rows.map((r) => r.slots), [['data'], ['choice', 'free-text']]);
  });

  it('주소: 종류를 고르기 전과 뒤', () => {
    assert.equal(designPath('tabs'), '/create/new/design/tabs');
    assert.equal(designPath('tabs', 'video'), '/create/new/design/tabs/video');
    assert.equal(designDataPath('tabs', 'video'), '/create/new/design/tabs/video/data');
  });
});

for (const design of ROUGH_DESIGNS) {
  for (const type of TASK_TYPES) {
    describe(`${design.id} × ${type.id}`, () => {
      const built = buildDesignTemplate(design, type);
      const lint = lintLayout(built.html);
      const columns = extractPlaceholders(built.html);

      it('layout 검사에 오류와 경고가 없다', () => {
        assert.equal(lint.kind, 'ann');
        assert.equal(hasLayoutErrors(lint), false, JSON.stringify(lint.problems));
        assert.deepEqual(lint.problems.filter((p) => p.level === 'warning'), []);
        assert.ok(lint.questions.length >= 1);
      });

      it('표본 행이 컬럼을 빠짐없이 채우고 남는 값이 없다', () => {
        assert.deepEqual(Object.keys(built.sampleRow).sort(), [...columns].sort());
        for (const value of Object.values(built.sampleRow)) assert.ok(typeof value === 'string' && value !== '');
      });

      it('미리보기: 표본을 넣으면 치환되지 않은 칸이 없다', () => {
        const page = renderTemplate(built.html, built.sampleRow, { preview: true });
        assert.deepEqual(extractPlaceholders(page.slice(page.indexOf('<ann-form>'))), []);
      });

      it('task 종류에 맞는 요소로 데이터를 보이고, 표본 그림 파일이 실제로 있다', () => {
        const tag = { vision: 'ann-image', video: 'ann-video', text: 'ann-text' }[type.id];
        assert.ok(built.html.includes(`<${tag} `));
        if (type.id === 'text') return;
        for (const name of columns.filter((c) => c !== 'items')) {
          assert.ok(core.isImageSource(built.sampleRow[name]), '영상 표본도 그림이다');
          assert.ok(existsSync(new URL(built.sampleRow[name].slice(1), SRC)), built.sampleRow[name]);
        }
      });

      it('미리 채우는 속성이 Enter Properties 의 검사를 통과한다', () => {
        assert.deepEqual(validateProperties(built.properties), {});
        for (const key of Object.keys(built.properties)) assert.ok(key in DEFAULT_SETTINGS, key);
      });

      it('흐름: Project 저장 요청 → JSON 양식 → Upload JSON 검사를 통과하고 표본 행과 같다', () => {
        const request = toSaveRequest({ projectId: null, name: built.name, html: built.html, settings: built.properties, sampleRow: built.sampleRow });
        assert.equal(request.name, built.name);
        assert.equal('id' in request, false);
        assert.deepEqual(request.sampleRow, built.sampleRow);
        const data = parseJsonData(formatJsonTemplate(columns, built.sampleRow), 'template.json');
        const check = checkData(columns, data.columns, data.rows);
        assert.deepEqual(check.missingColumns, []);
        assert.deepEqual(data.rows, [built.sampleRow]);
      });
    });
  }
}

describe('가안별 모양', () => {
  const vision = taskTypeById('vision');
  it('탭 가안은 탭마다 컬럼과 답 이름이 따로 있다', () => {
    const { html, sampleRow } = buildDesignTemplate(roughDesignById('tabs'), vision);
    assert.equal(html.match(/<ann-tab /g).length, 3);
    assert.deepEqual(Object.keys(sampleRow), ['image_url_1', 'image_url_2', 'image_url_3']);
    assert.deepEqual(lintLayout(html).questions.map((q) => q.name), ['setting_1', 'setting_2', 'setting_3']);
  });

  it('비교 가안은 데이터 두 칸과 고르는 문항 하나다', () => {
    const { html, sampleRow } = buildDesignTemplate(roughDesignById('compare'), vision);
    assert.deepEqual(Object.keys(sampleRow), ['image_url_a', 'image_url_b']);
    assert.deepEqual(lintLayout(html).questions.map((q) => q.name), ['preference']);
  });

  it('항목별 판단 가안은 항목을 JSON 컬럼에서 읽는다', () => {
    const { html, sampleRow } = buildDesignTemplate(roughDesignById('item-list'), vision);
    assert.ok(html.includes('<script type="application/json">${items}</script>'));
    assert.equal(core.parseItems(sampleRow.items).length, 4);
  });

  it('A 와 B 의 답은 객관식과 약술형이다', () => {
    for (const id of ['side-by-side', 'stacked']) {
      assert.deepEqual(lintLayout(buildDesignTemplate(roughDesignById(id), vision).html).questions.map((q) => q.tag), ['ann-choice', 'ann-textarea']);
    }
  });
});

describe('findSameProject', () => {
  const saved = [{ id: 't1', name: 'Tabs (Video)', html: '<a>' }];
  it('이름과 layout 이 같으면 저장된 Project 를 쓴다', () => {
    assert.equal(findSameProject(saved, ' Tabs (Video) ', '<a>').id, 't1');
  });
  it('이름이나 layout 이 다르면 새로 만든다', () => {
    assert.equal(findSameProject(saved, 'Other', '<a>'), null);
    assert.equal(findSameProject(saved, 'Tabs (Video)', '<b>'), null);
  });
});

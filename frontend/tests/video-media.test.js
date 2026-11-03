// 영상 데이터의 경로: /media/ 서빙 설정과, 그 주소가 binding 을 거쳐 ann-video 로 그려지는 흐름.
// 실제 재생과 버튼은 브라우저에서 확인한다. 여기서는 정답 파일이 새 나가지 않는 설정이 유지되는지를 본다.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { boundRow, buildBoundTemplate, checkBinding, dataReader, draftBinding } from '../src/lib/design-binding.js';
import { parseJsonData } from '../src/lib/json-data.js';
import { hasLayoutErrors, lintLayout } from '../src/lib/layout-lint.js';

const repo = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const nginx = repo('frontend/nginx.conf.template');
const readerOf = (rows) => dataReader(parseJsonData(JSON.stringify(rows), 't.json'));

describe('/media/ 서빙', () => {
  const clipRule = /location ~\* \^\/media\/\(\?<clip_file>\[\^\/\]\+\\\.mp4\)\$ \{/;

  it('.mp4 만 내려 주고, 하위 폴더 경로는 받지 않는다', () => {
    assert.match(nginx, clipRule);
  });

  it('그 밖의 /media/ 요청은 404 이고 SPA fallback 으로 가지 않는다', () => {
    assert.match(nginx, /location \/media\/ \{\s*return 404;\s*\}/);
  });

  it('요소 파일과 같은 캐시 정책으로 클립을 내려 준다', () => {
    const rule = nginx.slice(nginx.search(clipRule), nginx.indexOf('location /media/ {'));
    assert.match(rule, /alias \/usr\/share\/nginx\/media\/\$clip_file;/);
    assert.match(rule, /no-cache/);
  });

  it('compose 는 데이터 폴더를 읽기 전용으로 잇고, 그 폴더는 저장소에 들어가지 않는다', () => {
    assert.match(repo('docker-compose.yml'), /- \.\/var\/video-demo:\/usr\/share\/nginx\/media:ro/);
    assert.match(repo('.gitignore'), /^var\/$/m);
  });
});

describe('/media/ 주소에서 ann-video 까지', () => {
  const hits = readerOf([{ video_url: '/media/clip.mp4', question: 'Who is at the trays?', answer_gold: 'worker' }]);

  it('첫 binding 이 주소 컬럼을 고르고 플레이어로 그린다', () => {
    const draft = draftBinding('side-by-side', 'video', hits);
    assert.equal(draft.slots.data.from, 'video_url');
    const check = checkBinding(draft, hits);
    assert.deepEqual(check.errors, []);
    const html = buildBoundTemplate(draft, check.design, check.taskType, check.tabs);
    assert.ok(html.includes('<ann-video label="Video" src="${slot_data}"></ann-video>'));
    assert.equal(boundRow(draft, check.design, check.taskType, check.tabs, hits, 0).slot_data, '/media/clip.mp4');
    assert.equal(hasLayoutErrors(lintLayout(html)), false);
  });

  it('영상 옆의 글은 kind 로 나누고, 글을 영상 칸에 넣으면 이유를 알린다', () => {
    const base = { design: 'side-by-side', task_type: 'video', slots: { choice: { name: 'ok', header: 'Is the question right?', options: [['yes', 'Yes'], ['no', 'No']] }, 'free-text': { name: 'note', header: 'Why?' } } };
    const both = checkBinding({ ...base, slots: { ...base.slots, data: [{ label: 'Video', from: 'video_url' }, { label: 'Question', from: 'question', kind: 'text' }] } }, hits);
    assert.deepEqual(both.errors, []);
    const wrong = checkBinding({ ...base, slots: { ...base.slots, data: { label: 'Question', from: 'question' } } }, hits);
    assert.match(wrong.errors.join(' '), /does not look like a URL/);
  });

  it('플레이어의 버튼은 문항이 아니라 답의 모양에 들어가지 않는다', () => {
    const draft = draftBinding('side-by-side', 'video', hits);
    const check = checkBinding(draft, hits);
    const lint = lintLayout(buildBoundTemplate(draft, check.design, check.taskType, check.tabs));
    assert.deepEqual(lint.questions.map((question) => question.name).sort(), ['notes', 'setting']);
  });
});

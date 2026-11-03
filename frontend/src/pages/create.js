// Create: MTurk 의 Requester 화면처럼 Project 를 만들고, Project 에 HIT 데이터를 올려 batch 를 게시한다.
//   /create                            Project 목록 ("New Batch with an Existing Project")      pages/create/projects.js
//   /create/new                        rough design 고르기 ("New Project")                     pages/create/rough-design.js
//   /create/new/design/:designId(/:taskType)  task 종류 고르기와 예시 미리보기                       pages/create/rough-design.js
//   /create/new/gallery                다른 시작 방법: starter, HTML 올리기, 원본 데이터에서 만들기   pages/create/new-project.js
//   /create/project/:projectId/:tab    Project 편집기: Enter Properties, Design Layout, Preview and Finish  pages/create/project-editor.js
//   /create/publish/:projectId         Publish Batch: Upload JSON → Preview tasks → Review settings → Confirm and publish  pages/create/publish-batch.js
//   /create/tutorial                   처음 쓰는 사람을 위한 따라 하기 안내 (한국어)                          pages/create/tutorial.js
// 서버에서는 템플릿 레코드 하나가 Project 하나다 (layout = html, 속성 = properties, 미리보기 표본 = sampleRow).

import { renderNewProject } from './create/new-project.js';
import { renderProjectEditor } from './create/project-editor.js';
import { renderProjects } from './create/projects.js';
import { renderDesignTask, renderRoughDesigns } from './create/rough-design.js';
import { renderPublishBatch } from './create/publish-batch.js';
import { renderTutorial } from './create/tutorial.js';

export function render(root, _params, signal) {
  return renderProjects(root, signal);
}

export function renderNew(root, _params, signal) {
  return renderRoughDesigns(root, signal);
}

export function renderDesign(root, params, signal) {
  return renderDesignTask(root, params, signal);
}

export function renderGallery(root, _params, signal) {
  return renderNewProject(root, signal);
}

export function renderProject(root, params, signal) {
  return renderProjectEditor(root, params, signal);
}

export function renderPublish(root, params, signal) {
  return renderPublishBatch(root, params, signal);
}

export function renderGuide(root) {
  return renderTutorial(root);
}

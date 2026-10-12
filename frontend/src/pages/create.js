// Create: MTurk 의 Requester 화면처럼 Project 를 만들고, Project 에 CSV 를 올려 batch 를 게시한다.
//   /create                            Project 목록 ("New Batch with an Existing Project")      pages/create/projects.js
//   /create/new                        템플릿 고르기 ("New Project")                          pages/create/new-project.js
//   /create/project/:projectId/:tab    Project 편집기: Enter Properties, Design Layout, Preview and Finish  pages/create/project-editor.js
//   /create/publish/:projectId         Publish Batch: Upload CSV → Preview tasks → Review settings → Confirm and publish  pages/create/publish-batch.js
// 서버에서는 템플릿 레코드 하나가 Project 하나다 (layout = html, 속성 = properties, 미리보기 표본 = sampleRow).

import { renderNewProject } from './create/new-project.js';
import { renderProjectEditor } from './create/project-editor.js';
import { renderProjects } from './create/projects.js';
import { renderPublishBatch } from './create/publish-batch.js';

export function render(root, _params, signal) {
  return renderProjects(root, signal);
}

export function renderNew(root, _params, signal) {
  return renderNewProject(root, signal);
}

export function renderProject(root, params, signal) {
  return renderProjectEditor(root, params, signal);
}

export function renderPublish(root, params, signal) {
  return renderPublishBatch(root, params, signal);
}

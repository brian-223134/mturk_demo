// Create 의 첫 화면: Project 목록 (MTurk 의 "New Batch with an Existing Project"). 저장된 템플릿 레코드 하나가 Project 하나다.
// 행마다 Publish Batch(CSV 를 올려 게시), Edit(속성과 layout 고치기), Copy, Delete 가 있다.
// 이어서 하던 batch 가 있으면(lib/draft.js 의 임시 저장) 위쪽에 이어서 하기를 알린다.

import { api } from '../../api-client/client.js';
import { el } from '../../components/dom.js';
import { EMPTY, formatDateTime } from '../../components/format.js';
import { errorNotice, loading, notice } from '../../components/notice.js';
import { confirmModal } from '../../components/modal.js';
import { table } from '../../components/table.js';
import { toast } from '../../components/toast.js';
import { draftStorage } from '../../lib/draft.js';
import { settingsFromProperties } from '../../lib/settings.js';
import { navigate } from '../../router.js';
import { createSubnav, layoutKindTag, placeholderTags } from './common.js';

const VISIBLE_PLACEHOLDERS = 4;

/** 한 번만 보일 안내 (Finish 뒤에 목록으로 올 때). */
let pendingFlash = null;
export function flashOnProjects(message, projectId = null) {
  pendingFlash = { message, projectId };
}

export async function renderProjects(root, signal) {
  const body = el('div', { id: 'projects-body' }, loading());
  const resumeSlot = el('div', { id: 'resume-batch' });
  const flash = pendingFlash;
  pendingFlash = null;
  // root.append 는 el() 과 달리 null 을 글자로 넣으므로 걸러 낸다
  const parts = [
    el('div', { className: 'page-header' }, el('h2', { className: 'page-title' }, 'Create'), el('span', { className: 'page-header-right' }, el('a', { href: '/create/new', className: 'btn btn-primary', id: 'new-project' }, 'New Project'))),
    createSubnav('projects'),
    flash ? notice('success', flash.message) : null,
    resumeSlot,
    el('section', { className: 'panel', id: 'projects-panel' }, el('div', { className: 'panel-head' }, el('h3', { className: 'panel-title' }, 'Projects')), body),
  ];
  root.append(...parts.filter(Boolean));

  async function load() {
    let templates;
    try {
      templates = await api.listTemplates();
    } catch (error) {
      if (!signal.aborted) body.replaceChildren(errorNotice(error, 'Projects'));
      return;
    }
    if (signal.aborted) return;
    body.replaceChildren(projectTable(templates, flash?.projectId ?? null, load, signal));
    void showResume(templates);
  }

  async function showResume(templates) {
    const loaded = await draftStorage().load();
    if (signal.aborted || !loaded?.draft.templateId) return;
    const project = templates.find((t) => t.id === loaded.draft.templateId);
    if (!project) return;
    const { draft } = loaded;
    const what = draft.data ? `${draft.data.fileName}, ${draft.data.rows.length.toLocaleString('en-US')} rows` : 'no CSV yet';
    resumeSlot.replaceChildren(
      notice(
        'info',
        el('span', {}, 'You have an unfinished batch for ', el('strong', {}, project.name), ` (${what}).`),
        null,
        el('div', { className: 'notice-actions' }, el('a', { href: `/create/publish/${encodeURIComponent(project.id)}`, className: 'btn btn-small', id: 'resume-batch-link' }, 'Continue publishing')),
      ),
    );
  }

  await load();
  return undefined;
}

function projectTable(templates, highlightId, reload, signal) {
  const columns = [
    {
      title: 'Project',
      render: (t) =>
        el(
          'div',
          { className: 'template-name-cell' },
          el('span', {}, el('a', { href: `/create/project/${encodeURIComponent(t.id)}/properties`, className: 'project-name' }, el('strong', {}, t.name)), ' ', layoutKindTag(t.html)),
          el('span', { className: 'muted small' }, t.id),
        ),
    },
    {
      title: 'Title shown to workers',
      render: (t) => (t.properties?.Title ? t.properties.Title : el('span', { className: 'muted' }, 'Not set (defaults are used)')),
    },
    {
      title: 'Reward',
      width: 90,
      align: 'right',
      className: 'tabular',
      render: (t) => {
        const settings = settingsFromProperties(t.properties);
        return t.properties ? `$${settings.Reward}` : EMPTY;
      },
    },
    {
      title: 'Assignments',
      width: 100,
      align: 'right',
      className: 'tabular',
      render: (t) => (t.properties && Number.isInteger(t.properties.MaxAssignments) ? String(t.properties.MaxAssignments) : EMPTY),
    },
    {
      title: 'Variables',
      render: (t) => {
        const names = t.placeholders ?? [];
        const hidden = names.length - VISIBLE_PLACEHOLDERS;
        return [
          placeholderTags(names.slice(0, VISIBLE_PLACEHOLDERS)),
          hidden > 0 ? el('span', { className: 'muted small', title: names.slice(VISIBLE_PLACEHOLDERS).join(', ') }, ` +${hidden} more`) : null,
        ];
      },
    },
    { title: 'Last edited', width: 150, render: (t) => formatDateTime(t.updatedAt) },
    {
      title: '',
      width: 330,
      render: (t) =>
        el(
          'div',
          { className: 'row-actions' },
          el('a', { href: `/create/publish/${encodeURIComponent(t.id)}`, className: 'btn btn-small btn-primary', dataset: { action: 'publish', projectId: t.id } }, 'Publish Batch'),
          el('a', { href: `/create/project/${encodeURIComponent(t.id)}/properties`, className: 'btn btn-small', dataset: { action: 'edit', projectId: t.id } }, 'Edit'),
          el('button', { type: 'button', className: 'btn btn-small', dataset: { action: 'copy', projectId: t.id }, onClick: () => void copyProject(t, reload, signal) }, 'Copy'),
          el('button', { type: 'button', className: 'btn btn-small btn-link-danger', dataset: { action: 'delete', projectId: t.id }, onClick: () => void deleteProject(t, reload, signal) }, 'Delete'),
        ),
    },
  ];
  return table({
    columns,
    rows: templates,
    rowKey: (t) => t.id,
    rowAttrs: (t) => ({ className: `project-row${t.id === highlightId ? ' highlight' : ''}`, dataset: { projectId: t.id } }),
    empty: el('span', {}, 'No projects yet. ', el('a', { href: '/create/new' }, 'Create one from a template'), '.'),
    className: 'project-table',
  });
}

async function copyProject(template, reload, signal) {
  try {
    const copy = await api.saveTemplate({
      name: `${template.name} (copy)`,
      html: template.html,
      ...(template.properties ? { properties: template.properties } : {}),
      ...(template.sampleRow ? { sampleRow: template.sampleRow } : {}),
    });
    if (signal.aborted) return;
    toast.success(`Copied to "${copy.name}".`);
    navigate(`/create/project/${encodeURIComponent(copy.id)}/properties`);
  } catch (error) {
    if (!signal.aborted) toast.error('Could not copy the project', error.message);
    void reload();
  }
}

async function deleteProject(template, reload, signal) {
  const ok = await confirmModal({
    title: 'Delete project',
    message: `Delete "${template.name}"? Batches already published from it keep their own copy of the layout and are not affected.`,
    okText: 'Delete',
    danger: true,
  });
  if (!ok || signal.aborted) return;
  try {
    await api.deleteTemplate(template.id);
    if (signal.aborted) return;
    toast.success(`Deleted "${template.name}".`);
  } catch (error) {
    if (!signal.aborted) toast.error('Could not delete the project', error.message);
  }
  void reload();
}

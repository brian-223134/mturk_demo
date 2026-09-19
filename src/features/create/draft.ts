// 5.2: "진행 중인 입력은 브라우저에 임시 저장되어 새로고침해도 유지된다."
// CSV가 수 MB일 수 있어 localStorage가 아니라 IndexedDB에 둔다 (3.2). 저장소를 못 써도 wizard는 동작해야 하므로
// 이 파일의 함수는 오류를 던지지 않는다.

import { delMany, getMany, set } from 'idb-keyval';
import type { AnswerField } from '../../api/types';
import type { CsvData } from './csv';
import { DEFAULT_SETTINGS, type SettingsValues } from './settings';

export const STEP_TITLES = ['Template', 'Data', 'Settings', 'Preview & Cost', 'Publish'] as const;
export const LAST_STEP = STEP_TITLES.length - 1;

export interface TemplateEditorState {
  /** 저장된 템플릿을 고치는 중이면 그 id. 새로 만드는 중이면 null */
  id: string | null;
  name: string;
  html: string;
}

export interface CreateDraft {
  step: number; // 0부터
  templateMode: 'saved' | 'new';
  templateId: string | null;
  editor: TemplateEditorState;
  data: CsvData | null;
  settings: SettingsValues;
  previewRow: number; // 0부터
  /** 비어 있으면 Publish 단계가 "<템플릿 이름> <날짜>"를 제안한다 */
  batchName: string;
  /** 미리보기에서 읽어 낸 문항 목록. 게시할 때 answerSchema로 보낸다 */
  answerSchema: AnswerField[];
}

export function emptyDraft(): CreateDraft {
  return {
    step: 0,
    templateMode: 'saved',
    templateId: null,
    editor: { id: null, name: '', html: '' },
    data: null,
    settings: { ...DEFAULT_SETTINGS },
    previewRow: 0,
    batchName: '',
    answerSchema: [],
  };
}

export const DRAFT_KEY = 'mturk-console:create-draft';
// 폼에 글자를 칠 때마다 수 MB의 CSV를 다시 쓰지 않게 CSV는 다른 키에 두고, 바뀌었을 때만 쓴다
export const DRAFT_CSV_KEY = 'mturk-console:create-draft:csv';
const DRAFT_VERSION = 1;
const LOAD_TIMEOUT_MS = 3000;

interface StoredDraft extends Omit<CreateDraft, 'data'> {
  version: number;
  savedAt: string;
  hasData: boolean;
}

// 저장과 삭제가 섞이지 않게 한 줄로 세운다 (저장 도중에 Start over를 누르면 CSV 키만 남을 수 있다)
let queue: Promise<void> = Promise.resolve();
let storedCsv: CsvData | null | undefined; // 마지막으로 저장한 CSV. 참조가 같으면 다시 쓰지 않는다

// 저장소를 못 쓰는 환경에서 입력할 때마다 경고가 쌓이지 않게 한 번만 알린다
let warned = false;
function warnOnce(error: unknown): void {
  if (!warned) console.warn('[create] The wizard draft cannot use IndexedDB. The wizard still works, but a reload loses the input.', error);
  warned = true;
}

function enqueue(task: () => Promise<void>): Promise<void> {
  queue = queue.then(task).catch((error: unknown) => {
    warnOnce(error);
    storedCsv = undefined;
  });
  return queue;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCsvData(value: unknown): value is CsvData {
  return isObject(value) && Array.isArray(value.columns) && Array.isArray(value.rows) && typeof value.fileName === 'string';
}

export interface LoadedDraft {
  draft: CreateDraft;
  savedAt: string;
}

export async function loadDraft(): Promise<LoadedDraft | null> {
  try {
    // 일부 환경에서는 IndexedDB 요청이 오류도 없이 끝나지 않는다 (src/api/mock/idbSnapshot.ts와 같은 이유)
    const [stored, csv] = await Promise.race([
      getMany<unknown>([DRAFT_KEY, DRAFT_CSV_KEY]),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`IndexedDB did not respond within ${LOAD_TIMEOUT_MS} ms`)), LOAD_TIMEOUT_MS),
      ),
    ]);
    if (!isObject(stored) || stored.version !== DRAFT_VERSION) return null;
    const { version: _version, savedAt, hasData, ...rest } = stored as unknown as StoredDraft;
    const base = emptyDraft();
    const data = hasData && isCsvData(csv) ? { ...csv, warnings: csv.warnings ?? [] } : null;
    const draft: CreateDraft = {
      ...base,
      ...rest,
      editor: { ...base.editor, ...rest.editor },
      // 나중에 추가된 설정 항목이 저장본에 없어도 기본값으로 채워진다
      settings: { ...base.settings, ...rest.settings },
      answerSchema: Array.isArray(rest.answerSchema) ? rest.answerSchema : [],
      data,
    };
    draft.step = Math.min(Math.max(0, Math.trunc(Number(draft.step)) || 0), LAST_STEP);
    return { draft, savedAt: typeof savedAt === 'string' ? savedAt : '' };
  } catch (error) {
    warnOnce(error);
    return null;
  }
}

/** 화면에 올린 CSV가 이미 저장소에 있는 것임을 알린다 (복원 직후에 같은 CSV를 다시 쓰지 않게). */
export function markCsvStored(data: CsvData | null): void {
  storedCsv = data;
}

export function saveDraft(draft: CreateDraft): Promise<void> {
  return enqueue(async () => {
    const { data, ...rest } = draft;
    const stored: StoredDraft = { ...rest, version: DRAFT_VERSION, savedAt: new Date().toISOString(), hasData: data !== null };
    if (storedCsv !== data) {
      if (data) await set(DRAFT_CSV_KEY, data);
      else await delMany([DRAFT_CSV_KEY]);
      storedCsv = data;
    }
    await set(DRAFT_KEY, stored);
  });
}

export function clearDraft(): Promise<void> {
  return enqueue(async () => {
    storedCsv = undefined;
    await delMany([DRAFT_KEY, DRAFT_CSV_KEY]);
  });
}

// wizard 상태와 임시 저장(5.2)을 묶은 hook. 상태는 React에 두고, IndexedDB에는 늦춰서 쓴다.

import { useCallback, useEffect, useRef, useState } from 'react';
import { clearDraft, emptyDraft, loadDraft, markCsvStored, saveDraft, type CreateDraft } from './draft';

const SAVE_DEBOUNCE_MS = 400;

export type DraftUpdate = Partial<CreateDraft> | ((draft: CreateDraft) => Partial<CreateDraft>);

export interface CreateDraftHandle {
  draft: CreateDraft;
  /** 저장본을 읽기 전에는 false. 그 전에 화면을 그리면 빈 wizard가 잠깐 보였다가 바뀐다 */
  ready: boolean;
  /** 저장본에서 복원했으면 저장 시각(ISO), 아니면 null */
  restoredFrom: string | null;
  update: (change: DraftUpdate) => void;
  /** 입력을 전부 버리고 저장본도 지운다 (Start over, 게시 후) */
  reset: () => void;
}

export function useCreateDraft(): CreateDraftHandle {
  const [draft, setDraft] = useState<CreateDraft>(emptyDraft);
  const [ready, setReady] = useState(false);
  const [restoredFrom, setRestoredFrom] = useState<string | null>(null);

  const latest = useRef(draft);
  latest.current = draft;
  // 사용자가 아무것도 바꾸지 않았으면 쓰지 않는다 (빈 draft 저장, 게시 직후의 재저장을 막는다)
  const dirty = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void loadDraft().then((loaded) => {
      if (cancelled) return;
      if (loaded) {
        markCsvStored(loaded.draft.data);
        setDraft(loaded.draft);
        setRestoredFrom(loaded.savedAt);
      }
      setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!ready || !dirty.current) return;
    const timer = setTimeout(() => {
      dirty.current = false;
      void saveDraft(draft);
    }, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [draft, ready]);

  // 대기 중인 저장을 놓치지 않게, 다른 탭으로 가거나 새로고침할 때는 바로 쓴다
  useEffect(() => {
    if (!ready) return;
    const flush = () => {
      if (!dirty.current) return;
      dirty.current = false;
      void saveDraft(latest.current);
    };
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, [ready]);

  const update = useCallback((change: DraftUpdate) => {
    dirty.current = true;
    setDraft((current) => ({ ...current, ...(typeof change === 'function' ? change(current) : change) }));
  }, []);

  const reset = useCallback(() => {
    dirty.current = false;
    setRestoredFrom(null);
    setDraft(emptyDraft());
    void clearDraft();
  }, []);

  return { draft, ready, restoredFrom, update, reset };
}

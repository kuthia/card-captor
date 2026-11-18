import { useEffect, useRef, useState } from 'react';
import { advanceCodexMini, codex, EMPTY_CODEX, EMPTY_CODEX_MINI, isNewerCodexSnapshot, type CodexMiniState, type CodexPreferences, type CodexSnapshot } from './codex';
import { errorMessage } from './provider';
import { measurement } from './benchmark';
import { characterValidation } from './validation';

export function useCodex() {
  const [snapshot, setSnapshot] = useState<CodexSnapshot>(EMPTY_CODEX);
  const [mini, setMini] = useState<CodexMiniState>(EMPTY_CODEX_MINI);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const current = useRef(EMPTY_CODEX);
  const miniRef = useRef(EMPTY_CODEX_MINI);
  const busy = useRef(false);

  useEffect(() => {
    if (measurement || characterValidation) return;
    let canceled = false;
    let stop: (() => void) | undefined;
    const accept = (next: CodexSnapshot, initial = false) => {
      if (canceled || !isNewerCodexSnapshot(current.current, next)) return;
      miniRef.current = advanceCodexMini(initial ? null : current.current, next, miniRef.current, Date.now());
      current.current = next; setSnapshot(next); setMini(miniRef.current);
    };
    codex.subscribe(next => accept(next)).then(unsubscribe => {
      if (canceled) { unsubscribe(); return; }
      stop = unsubscribe;
      return codex.get().then(next => accept(next, true));
    }).catch(value => { if (!canceled) setError(errorMessage(value, 'Codex 피드를 연결하지 못했어요.')); });
    return () => { canceled = true; stop?.(); };
  }, []);

  useEffect(() => {
    if (mini.expiresAt === null) return;
    const expiresAt = mini.expiresAt;
    const id = window.setTimeout(() => {
      if (miniRef.current.expiresAt !== expiresAt) return;
      miniRef.current = advanceCodexMini(current.current, current.current, miniRef.current, Math.max(Date.now(), expiresAt));
      setMini(miniRef.current);
    }, Math.max(0, mini.expiresAt - Date.now()));
    return () => window.clearTimeout(id);
  }, [mini.expiresAt]);

  async function save(preferences: CodexPreferences) {
    if (busy.current || measurement || characterValidation) return;
    busy.current = true; setSaving(true); setError(null);
    try {
      const next = await codex.save(preferences);
      if (isNewerCodexSnapshot(current.current, next)) {
        miniRef.current = advanceCodexMini(current.current, next, miniRef.current, Date.now());
        current.current = next; setSnapshot(next); setMini(miniRef.current);
      }
    } catch (value) { setError(errorMessage(value, 'Codex 알림 설정을 저장하지 못했어요.')); }
    finally { busy.current = false; setSaving(false); }
  }
  return { snapshot, bubble: mini.bubble, error, saving, save,
    reportError: (value: unknown) => setError(errorMessage(value, 'Codex 작업을 열지 못했어요.')) };
}

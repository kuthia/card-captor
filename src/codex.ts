import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { desktop } from './provider';
import { measurement } from './benchmark';
import { characterValidation } from './validation';

const isolated = !!measurement || characterValidation;

export type CodexPhase = 'running' | 'needsInput' | 'ready' | 'blocked' | 'interrupted' | 'idle';
export interface CodexPreferences { enabled: boolean; notifications: boolean; sound: boolean }
export interface CodexTask { id: string; title: string; phase: CodexPhase; turnId: string | null; summary: string; stale: boolean; updatedAt: string }
export interface CodexActivity { id: string; threadId: string; title: string; phase: CodexPhase; message: string; at: string; unread: boolean }
export interface CodexSnapshot {
  revision: number;
  connection: string;
  detail: string;
  preferences: CodexPreferences;
  tasks: CodexTask[];
  activities: CodexActivity[];
  alert: CodexActivity | null;
  deliveryWarning: string | null;
}
export const CODEX_PHASE_LABELS: Record<CodexPhase, string> = {
  running: '작업 중', needsInput: '확인이 필요해요', ready: '작업을 마쳤어요',
  blocked: '작업에 문제가 생겼어요', interrupted: '작업이 중단됐어요', idle: '대기 중',
};
export const EMPTY_CODEX: CodexSnapshot = {
  revision: 0, connection: desktop ? 'connecting' : 'preview',
  detail: desktop ? 'Codex 앱을 찾고 있어요.' : '실제 연결은 데스크톱 앱에서 사용할 수 있어요.',
  preferences: { enabled: true, notifications: true, sound: true }, tasks: [], activities: [], alert: null, deliveryWarning: null,
};

/** Per-page synthetic state only. No generated activity is presented as a real Codex task. */
let preview = structuredClone(EMPTY_CODEX);
const subscribers = new Set<(snapshot: CodexSnapshot) => void>();
function publishPreview() { preview = { ...preview, revision: preview.revision + 1 }; subscribers.forEach(fn => fn(preview)); }

export const codex = {
  get: (): Promise<CodexSnapshot> => desktop && !isolated ? invoke('get_codex_feed') : Promise.resolve(preview),
  subscribe: async (accept: (snapshot: CodexSnapshot) => void): Promise<() => void> => {
    if (desktop && !isolated) return listen<CodexSnapshot>('codex-feed', event => accept(event.payload));
    subscribers.add(accept); return () => { subscribers.delete(accept); };
  },
  save: async (preferences: CodexPreferences): Promise<CodexSnapshot> => {
    if (isolated) throw new Error('검증·측정 모드에서는 Codex 설정을 변경하지 않습니다.');
    if (desktop) return invoke('set_codex_preferences', { preferences });
    preview = { ...preview, preferences, connection: preferences.enabled ? 'preview' : 'disabled',
      tasks: preview.tasks.map(task => ({ ...task, stale: !preferences.enabled })),
      alert: preferences.enabled && preferences.notifications ? preview.alert : null };
    publishPreview(); return preview;
  },
  open: (id: string): Promise<void> => desktop && !isolated ? invoke('open_codex_thread', { id }) : Promise.resolve(),
  testAlert: (): Promise<void> => desktop && !isolated ? invoke('test_codex_alert') : Promise.resolve(),
  simulate(phase: CodexPhase | 'reset' | 'progress') {
    if (desktop || isolated) return;
    if (phase === 'reset') { preview = { ...structuredClone(EMPTY_CODEX), revision: preview.revision }; publishPreview(); return; }
    if (!preview.preferences.enabled) return;
    const progress = phase === 'progress';
    const nextPhase = progress ? 'running' : phase;
    const summary = progress ? '합성 시나리오: 테스트 결과를 확인하고 변경 사항을 정리하고 있어요.'
      : nextPhase === 'ready' ? '합성 시나리오: 빌드와 테스트를 마쳤어요.' : nextPhase === 'running' ? '합성 시나리오: 변경 사항을 확인하고 있어요.' : '';
    const task: CodexTask = { id: 'preview-task', title: '미리보기 · 빌드와 변경 사항 확인', phase: nextPhase, turnId: 'preview-turn',
      summary, stale: false, updatedAt: new Date().toISOString() };
    if (preview.tasks[0]?.phase === nextPhase && preview.tasks[0]?.summary === summary) return;
    const item: CodexActivity = { id: `preview-${preview.revision + 1}`, threadId: task.id, title: task.title, phase: nextPhase,
      message: CODEX_PHASE_LABELS[nextPhase], at: task.updatedAt, unread: nextPhase !== 'running' };
    const transition = preview.tasks[0]?.phase !== nextPhase;
    preview = { ...preview, tasks: [task], activities: transition ? [item, ...preview.activities].slice(0, 40) : preview.activities,
      alert: transition && preview.preferences.notifications && nextPhase !== 'running' ? item : preview.alert };
    publishPreview();
  },
};

/** Ignore a slow initial response after a newer pushed snapshot. */
export function isNewerCodexSnapshot(current: CodexSnapshot, next: CodexSnapshot): boolean {
  return next.revision >= current.revision;
}
export function codexAttention(snapshot: CodexSnapshot): CodexTask | undefined {
  if (!snapshot.preferences.enabled || snapshot.connection === 'disconnected' || snapshot.connection === 'disabled') return undefined;
  const priority: CodexPhase[] = ['needsInput', 'blocked', 'running', 'ready', 'interrupted', 'idle'];
  return priority.flatMap(phase => snapshot.tasks.filter(task => task.phase === phase && !task.stale))[0];
}

/** One plain-text line; presentation never renders Codex-supplied HTML or Markdown. */
export function codexLine(value: string): string {
  return value.replace(/^\[(?:추천 )?페르소나:[^\]]*\]\s*/u, '')
    .replace(/!?\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(^|\n)\s{0,3}(?:#{1,6}|>|[-*+])\s+/g, '$1')
    .replace(/(\*\*|__|~~)(\S[\s\S]*?\S|\S)\1/g, '$2').replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ').trim();
}
export function codexTitle(value: string): string { return value.replace(/\s+/g, ' ').trim(); }
export function codexTaskContent(task: CodexTask): string {
  return codexLine(task.summary) || CODEX_PHASE_LABELS[task.phase];
}

export interface CodexBubble { threadId: string; title: string; content: string; phase: CodexPhase }
export interface CodexMiniState { bubble: CodexBubble | null; expiresAt: number | null }
export const EMPTY_CODEX_MINI: CodexMiniState = { bubble: null, expiresAt: null };
export const CODEX_MINI_HOLD_MS = 6500;

/** Live progress is independent of OS notifications. Old completed snapshots stay silent. */
export function advanceCodexMini(previous: CodexSnapshot | null, next: CodexSnapshot, current: CodexMiniState, now: number): CodexMiniState {
  if (!next.preferences.enabled || !['connected', 'preview'].includes(next.connection)) return EMPTY_CODEX_MINI;
  const tasks = next.tasks.filter(task => !task.stale);
  const active = (task: CodexTask) => task.phase === 'running' || task.phase === 'needsInput';
  const present = (task: CodexTask, expiresAt: number | null): CodexMiniState => ({
    bubble: { threadId: task.id, title: codexTitle(task.title), content: codexTaskContent(task), phase: task.phase }, expiresAt,
  });
  const changed = tasks.find(task => {
    const old = previous?.tasks.find(item => item.id === task.id);
    const differs = !old || old.stale || old.phase !== task.phase || old.turnId !== task.turnId || old.title !== task.title || old.summary !== task.summary;
    if (!differs || task.phase === 'idle') return false;
    if (active(task)) return true;
    return !!old && !old.stale && (old.phase !== task.phase || old.turnId !== task.turnId || current.bubble?.threadId === task.id);
  });
  if (changed) return present(changed, active(changed) ? null : now + CODEX_MINI_HOLD_MS);
  const retained = tasks.find(task => task.id === current.bubble?.threadId && task.phase !== 'idle');
  if (retained && (active(retained) || (current.expiresAt !== null && now < current.expiresAt))) return present(retained, current.expiresAt);
  const running = tasks.find(active);
  return running ? present(running, null) : EMPTY_CODEX_MINI;
}

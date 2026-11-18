import { describe, expect, it } from 'vitest';
import { advanceCodexMini, CODEX_MINI_HOLD_MS, codexAttention, codexLine, codexTitle, EMPTY_CODEX, EMPTY_CODEX_MINI, isNewerCodexSnapshot, type CodexSnapshot, type CodexTask } from './codex';

function miniSnapshot(phase: CodexTask['phase'], summary = ''): CodexSnapshot {
  return { ...EMPTY_CODEX, connection: 'connected', preferences: { enabled: true, notifications: false, sound: false },
    tasks: [{ id: 'one', title: '한 줄 제목', phase, summary, stale: false, turnId: 'turn-one', updatedAt: '' }] };
}

describe('Codex feed updates', () => {
  it('rejects a stale fetch after a pushed update', () => {
    expect(isNewerCodexSnapshot({ ...EMPTY_CODEX, revision: 9 }, { ...EMPTY_CODEX, revision: 4 })).toBe(false);
  });
  it('prioritizes input requests and hides stale tasks after disconnect', () => {
    const task = (id: string, phase: CodexTask['phase'], stale = false): CodexTask => ({ id, title: id, phase, stale, turnId: null, summary: '', updatedAt: '' });
    const snapshot = { ...EMPTY_CODEX, connection: 'connected', tasks: [task('done', 'ready'), task('work', 'running'), task('input', 'needsInput')] };
    expect(codexAttention(snapshot)?.id).toBe('input');
    expect(codexAttention({ ...snapshot, tasks: snapshot.tasks.map(t => ({ ...t, stale: true })) })).toBeUndefined();
    expect(codexAttention({ ...snapshot, connection: 'disconnected' })).toBeUndefined();
  });
});

describe('live two-line Codex Mini', () => {
  it('flattens content without changing issue references or code identifiers', () => {
    expect(codexTitle('Review Project #9\nmy_task')).toBe('Review Project #9 my_task');
    expect(codexLine('## **완료**\n`my_task`와 #9 확인')).toBe('완료 my_task와 #9 확인');
  });
  it('shows and updates progress without OS notification settings or terminal alerts', () => {
    const before = miniSnapshot('running', '파일을 확인하고 있어요');
    const first = advanceCodexMini(null, before, EMPTY_CODEX_MINI, 100);
    expect(first.bubble?.title).toBe('한 줄 제목');
    expect(first.bubble?.content).toBe('파일을 확인하고 있어요');
    expect(first.expiresAt).toBeNull();
    const after = miniSnapshot('running', '**테스트** 결과를\n확인하고 있어요');
    const next = advanceCodexMini(before, after, first, 200);
    expect(next.bubble?.content).toBe('테스트 결과를 확인하고 있어요');
    expect(next.expiresAt).toBeNull();
  });
  it('suppresses historical completion and hides terminal progress after the hold time', () => {
    const completed = miniSnapshot('ready', '완료했어요');
    expect(advanceCodexMini(null, completed, EMPTY_CODEX_MINI, 0).bubble).toBeNull();
    const running = miniSnapshot('running');
    const shown = advanceCodexMini(null, running, EMPTY_CODEX_MINI, 0);
    const done = advanceCodexMini(running, completed, shown, 100);
    expect(done.bubble?.content).toBe('완료했어요');
    expect(done.expiresAt).toBe(100 + CODEX_MINI_HOLD_MS);
    const noisy = { ...completed, revision: 22, tasks: completed.tasks.map(task => ({ ...task, updatedAt: 'later' })) };
    const unchanged = advanceCodexMini(completed, noisy, done, 1000);
    expect(unchanged.expiresAt).toBe(done.expiresAt);
    expect(advanceCodexMini(noisy, noisy, unchanged, done.expiresAt!).bubble).toBeNull();
  });
  it('keeps pending input visible and hides stale, disconnected, or disabled state', () => {
    const waiting = miniSnapshot('needsInput');
    const shown = advanceCodexMini(null, waiting, EMPTY_CODEX_MINI, 0);
    expect(shown.bubble?.content).toBe('확인이 필요해요');
    expect(advanceCodexMini(waiting, waiting, shown, 60000).bubble).not.toBeNull();
    expect(advanceCodexMini(waiting, { ...waiting, connection: 'disconnected' }, shown, 10).bubble).toBeNull();
    expect(advanceCodexMini(waiting, { ...waiting, preferences: { ...waiting.preferences, enabled: false } }, shown, 10).bubble).toBeNull();
    expect(advanceCodexMini(waiting, { ...waiting, tasks: waiting.tasks.map(task => ({ ...task, stale: true })) }, shown, 10).bubble).toBeNull();
  });
  it('returns to another running task after a terminal bubble expires', () => {
    const working = miniSnapshot('running', '다른 작업 진행 중');
    const previous = { ...working, tasks: [{ ...working.tasks[0], id: 'two' }, ...working.tasks] };
    const first = advanceCodexMini(null, previous, EMPTY_CODEX_MINI, 0);
    const completed = { ...previous, tasks: [{ ...previous.tasks[0], phase: 'ready' as const, summary: '완료' }, working.tasks[0]] };
    const done = advanceCodexMini(previous, completed, first, 10);
    expect(done.bubble?.threadId).toBe('two');
    expect(advanceCodexMini(completed, completed, done, done.expiresAt!).bubble?.threadId).toBe('one');
  });
});

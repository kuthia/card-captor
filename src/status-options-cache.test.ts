import { describe, expect, it, vi } from 'vitest';
import type { CardStatusEditor } from './contracts';
import { StatusOptionsCache } from './status-options-cache';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function editor(cardId = 'card-one', currentOptionId = 'todo'): CardStatusEditor {
  return {
    cardId,
    fields: [{
      id: 'task-status', name: '작업 상태', currentOptionId,
      options: [
        { id: 'todo', name: '시작 전', color: 'default' },
        { id: 'doing', name: '진행 중', color: 'blue' },
        { id: 'done', name: '검토 완료', color: 'red' },
      ],
    }, {
      id: 'review-status', name: '검토 상태', currentOptionId: null,
      options: [{ id: 'review', name: '검토 요청', color: 'pink' }],
    }],
  };
}

describe('per-card status option cache', () => {
  it('serves an immediate previous value while revalidating all fields and colors', async () => {
    const cache = new StatusOptionsCache();
    const original = editor();
    await cache.refresh('card-one', async () => original);
    const next = deferred<CardStatusEditor>();
    const reading = cache.refresh('card-one', () => next.promise);
    expect(cache.get('card-one')).toEqual(original);
    const changed = editor('card-one', 'doing');
    changed.fields[0].options.push({ id: 'blocked', name: '외부 응답 대기', color: 'purple' });
    next.resolve(changed);
    await reading;
    expect(cache.get('card-one')).toEqual(changed);
    expect(cache.get('card-one')?.fields[0].options[0].color).toBe('default');
    expect(cache.get('card-one')?.fields[1].currentOptionId).toBeNull();
  });

  it('retains prior data and permits another explicit read after a failed revalidation', async () => {
    const cache = new StatusOptionsCache();
    await cache.refresh('card-one', async () => editor());
    await expect(cache.refresh('card-one', async () => { throw new Error('권한 없음'); })).rejects.toThrow('권한 없음');
    expect(cache.get('card-one')).toEqual(editor());
    await cache.refresh('card-one', async () => editor('card-one', 'doing'));
    expect(cache.get('card-one')?.fields[0].currentOptionId).toBe('doing');
  });

  it('coalesces concurrent loader work but gives each consumer detached values', async () => {
    const cache = new StatusOptionsCache();
    const pending = deferred<CardStatusEditor>();
    const firstLoad = vi.fn(() => pending.promise);
    const secondLoad = vi.fn(async () => editor());
    const first = cache.refresh('card-one', firstLoad);
    const second = cache.refresh('card-one', secondLoad);
    await Promise.resolve();
    expect(firstLoad).toHaveBeenCalledTimes(1);
    expect(secondLoad).not.toHaveBeenCalled();
    pending.resolve(editor());
    const [left, right] = await Promise.all([first, second]);
    left.fields[0].options[0].name = 'local mutation';
    expect(right.fields[0].options[0].name).toBe('시작 전');
    expect(cache.get('card-one')?.fields[0].options[0].name).toBe('시작 전');
  });

  it('owns copies of loader results and cached reads', async () => {
    const cache = new StatusOptionsCache();
    const original = editor();
    const result = await cache.refresh('card-one', async () => original);
    original.fields[0].options.length = 0;
    result.fields[1].name = 'changed by caller';
    const cached = cache.get('card-one')!;
    cached.fields[0].currentOptionId = 'done';
    cached.fields[0].options[0].color = 'green';
    expect(cache.get('card-one')).toEqual(editor());
  });

  it('does not resurrect an old account or let its cleanup detach a newer read', async () => {
    const cache = new StatusOptionsCache();
    const old = deferred<CardStatusEditor>();
    const oldRead = cache.refresh('card-one', () => old.promise);
    cache.clear();
    const next = deferred<CardStatusEditor>();
    const newLoad = vi.fn(() => next.promise);
    const newRead = cache.refresh('card-one', newLoad);
    old.resolve(editor());
    await oldRead;
    expect(cache.get('card-one')).toBeUndefined();
    const duplicateLoad = vi.fn(async () => editor());
    const sharedNewRead = cache.refresh('card-one', duplicateLoad);
    next.resolve(editor('card-one', 'done'));
    await Promise.all([newRead, sharedNewRead]);
    expect(newLoad).toHaveBeenCalledTimes(1);
    expect(duplicateLoad).not.toHaveBeenCalled();
    expect(cache.get('card-one')?.fields[0].currentOptionId).toBe('done');
  });

  it('prunes absent cards including their unfinished reads, retaining only current cards', async () => {
    const cache = new StatusOptionsCache();
    const kept = deferred<CardStatusEditor>();
    const removed = deferred<CardStatusEditor>();
    const keepRead = cache.refresh('card-one', () => kept.promise);
    const removeRead = cache.refresh('card-two', () => removed.promise);
    await cache.refresh('card-three', async () => editor('card-three'));
    cache.retain(['card-one']);
    removed.resolve(editor('card-two'));
    kept.resolve(editor());
    await Promise.all([keepRead, removeRead]);
    expect(cache.get('card-one')).toEqual(editor());
    expect(cache.get('card-two')).toBeUndefined();
    expect(cache.get('card-three')).toBeUndefined();
  });

  it('keeps a confirmed write when a pre-write read finishes late', async () => {
    const cache = new StatusOptionsCache();
    await cache.refresh('card-one', async () => editor());
    const old = deferred<CardStatusEditor>();
    const oldRead = cache.refresh('card-one', () => old.promise);
    cache.recordChange('card-one', 'task-status', 'done');
    expect(cache.get('card-one')?.fields[0].currentOptionId).toBe('done');
    expect(cache.get('card-one')?.fields[1].currentOptionId).toBeNull();
    const next = deferred<CardStatusEditor>();
    const nextLoad = vi.fn(() => next.promise);
    const nextRead = cache.refresh('card-one', nextLoad);
    old.resolve(editor());
    await oldRead;
    expect(cache.get('card-one')?.fields[0].currentOptionId).toBe('done');
    const duplicateLoad = vi.fn(async () => editor());
    const sharedNextRead = cache.refresh('card-one', duplicateLoad);
    next.resolve(editor('card-one', 'done'));
    await Promise.all([nextRead, sharedNextRead]);
    expect(nextLoad).toHaveBeenCalledTimes(1);
    expect(duplicateLoad).not.toHaveBeenCalled();
    expect(cache.get('card-one')?.fields[0].currentOptionId).toBe('done');
  });

  it('rejects a different card response without replacing previous metadata', async () => {
    const cache = new StatusOptionsCache();
    await cache.refresh('card-one', async () => editor());
    await expect(cache.refresh('card-one', async () => editor('card-two'))).rejects.toThrow('카드가 변경되었습니다');
    expect(cache.get('card-one')).toEqual(editor());
    expect(cache.get('card-two')).toBeUndefined();
    await cache.refresh('card-one', async () => editor('card-one', 'doing'));
    expect(cache.get('card-one')?.fields[0].currentOptionId).toBe('doing');
  });
});

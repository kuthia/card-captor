import { describe, expect, it } from 'vitest';
import { RefreshScheduler } from './refresh';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (value: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('feed refresh across account changes', () => {
  it('drains an invalidated read before a write without starting a new read', async () => {
    const old = deferred<string>();
    let calls = 0;
    const accepted: string[] = [];
    const scheduler = new RefreshScheduler({
      canRefresh: () => true,
      load: () => { calls += 1; return old.promise; },
      accept: value => accepted.push(value), reject: () => {}, busy: () => {},
    });
    await scheduler.waitForIdle();
    expect(calls).toBe(0);
    void scheduler.request();
    await Promise.resolve();
    scheduler.invalidate();
    let canWrite = false;
    const drained = scheduler.waitForIdle().then(() => { canWrite = true; });
    await Promise.resolve();
    expect(canWrite).toBe(false);
    old.resolve('state before write');
    await drained;
    expect(canWrite).toBe(true);
    expect(calls).toBe(1);
    expect(accepted).toEqual([]);
  });

  it('discards a replaced token response on the same view and runs one latest read', async () => {
    const old = deferred<string>();
    const current = deferred<string>();
    let calls = 0;
    const accepted: string[] = [];
    const scheduler = new RefreshScheduler({
      canRefresh: () => true,
      load: () => ++calls === 1 ? old.promise : current.promise,
      accept: value => accepted.push(value), reject: () => {}, busy: () => {},
    });
    const done = scheduler.request();
    await Promise.resolve();
    scheduler.invalidate(); // Same view, different token.
    void scheduler.request(true);
    void scheduler.request(true); // Coalesce repeated setup refreshes.
    old.resolve('old account cards');
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toBe(2);
    expect(accepted).toEqual([]);
    current.resolve('current account cards');
    await done;
    expect(accepted).toEqual(['current account cards']);
    expect(calls).toBe(2);
  });

  it('cancels a reserved follow-up and rejects stale results on disconnect', async () => {
    const old = deferred<string>();
    let connected = true;
    let calls = 0;
    const accepted: string[] = [];
    const scheduler = new RefreshScheduler({
      canRefresh: () => connected,
      load: () => { calls += 1; return old.promise; },
      accept: value => accepted.push(value), reject: () => {}, busy: () => {},
    });
    const done = scheduler.request();
    await Promise.resolve();
    void scheduler.request(true);
    connected = false;
    scheduler.invalidate();
    old.resolve('disconnected cards');
    await done;
    expect(accepted).toEqual([]);
    expect(calls).toBe(1);
    expect(scheduler.isRunning).toBe(false);
  });

  it('retries after an explicit config change once, then stops on failure', async () => {
    const old = deferred<string>();
    let calls = 0;
    const errors: unknown[] = [];
    const scheduler = new RefreshScheduler({
      canRefresh: () => true,
      load: () => ++calls === 1 ? old.promise : Promise.reject('new connection failed'),
      accept: () => {}, reject: error => errors.push(error), busy: () => {},
    });
    const done = scheduler.request();
    await Promise.resolve();
    scheduler.invalidate();
    void scheduler.request(true);
    old.reject('old revision changed');
    await done;
    expect(calls).toBe(2);
    expect(errors).toEqual(['new connection failed']);
  });
});

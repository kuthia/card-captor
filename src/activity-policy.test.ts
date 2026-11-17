import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CursorInputWriter, POINTER_FAR_MS, POINTER_NEAR_MS, pointerPollDelay, startAdaptivePolling, startRoaming } from './activity-policy';
import type { Point } from './geometry';
import type { MotionState } from './motion';

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
afterEach(() => { vi.useRealTimers(); });

function roaming(context = {}) {
  let position: Point = { x: 20, y: 20 };
  const states: MotionState[] = [];
  const moves = vi.fn((next: Point) => { position = next; });
  const stop = startRoaming({
    context: { dragging: false, browsing: false, suspended: false, hovered: false, ...context },
    size: { width: 168, height: 180 },
    position: () => position,
    bounds: () => ({ left: 0, top: 0, right: 1600, bottom: 1000 }),
    move: moves,
    state: value => states.push(value),
    now: () => Date.now(),
    random: () => 1,
  });
  return { stop, states, moves, position: () => position };
}

describe('roaming wake policy', () => {
  it('can hold the measurement walking cadence without inserting resting phases', () => {
    let position: Point = { x: 20, y: 20 };
    const states: MotionState[] = [];
    const moves = vi.fn((next: Point) => { position = next; });
    let target = 0;
    const stop = startRoaming({
      context: { dragging: false, browsing: false, suspended: false, hovered: false },
      size: { width: 20, height: 20 },
      position: () => position,
      bounds: () => ({ left: 0, top: 0, right: 140, bottom: 140 }),
      move: moves,
      state: value => states.push(value),
      now: () => Date.now(),
      random: () => (Math.floor(target++ / 2) % 2 ? 0 : 1),
      continuous: true,
    });
    vi.advanceTimersByTime(15_000);
    expect(states[0]).toBe('idle');
    expect(states.slice(1).every(state => state === 'walk')).toBe(true);
    expect(moves.mock.calls.length).toBeGreaterThan(300);
    expect(moves.mock.calls.length).toBeLessThanOrEqual(450);
    stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rests on one deadline without generating idle position frames', () => {
    const loop = roaming();
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(3499);
    expect(loop.moves).not.toHaveBeenCalled();
    expect(loop.states).toEqual(['idle']);
    loop.stop();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(loop.moves).not.toHaveBeenCalled();
  });

  it.each([{ browsing: true }, { suspended: true }, { hovered: true }, { dragging: true }])(
    'owns no movement timer when blocked by %o', context => {
      const loop = roaming(context);
      vi.advanceTimersByTime(60_000);
      expect(vi.getTimerCount()).toBe(0);
      expect(loop.moves).not.toHaveBeenCalled();
      loop.stop();
    },
  );

  it('caps walking updates and preserves distance based on elapsed time', () => {
    const loop = roaming();
    vi.advanceTimersByTime(3500);
    expect(loop.states.at(-1)).toBe('walk');
    vi.advanceTimersByTime(1000);
    expect(loop.moves.mock.calls.length).toBeLessThanOrEqual(30);
    const distance = Math.hypot(loop.position().x - 20, loop.position().y - 20);
    expect(distance).toBeGreaterThan(33);
    expect(distance).toBeLessThanOrEqual(35);
    loop.stop();
    const calls = loop.moves.mock.calls.length;
    vi.advanceTimersByTime(10_000);
    expect(loop.moves).toHaveBeenCalledTimes(calls);
  });
});

describe('native pointer wake policy', () => {
  it('retains responsive polling near an interactive region and reduces distant polling', () => {
    const regions = [{ left: 400, top: 300, right: 568, bottom: 480 }];
    expect(pointerPollDelay({ x: 380, y: 350 }, regions, false)).toBe(POINTER_NEAR_MS);
    expect(pointerPollDelay({ x: 0, y: 0 }, regions, false)).toBe(POINTER_FAR_MS);
    expect(pointerPollDelay({ x: 0, y: 0 }, regions, true)).toBe(POINTER_NEAR_MS);
  });

  it('does not wake native polling for a hidden surface', async () => {
    const poll = vi.fn(async () => POINTER_FAR_MS);
    const stop = startAdaptivePolling({ enabled: false, poll });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(poll).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    stop();
  });

  it('never overlaps slow native requests or reschedules after disposal', async () => {
    let finish!: (delay: number) => void;
    const poll = vi.fn(() => new Promise<number>(resolve => { finish = resolve; }));
    const stop = startAdaptivePolling({ enabled: true, poll });
    await vi.advanceTimersByTimeAsync(5000);
    expect(poll).toHaveBeenCalledTimes(1);
    stop();
    finish(POINTER_NEAR_MS);
    await vi.advanceTimersByTimeAsync(5000);
    expect(poll).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('serializes a delayed hidden release before restoring the newest visible hit region', async () => {
    const calls: boolean[] = [];
    const finishes: (() => void)[] = [];
    let nativeState = true;
    const writer = new CursorInputWriter(ignored => {
      calls.push(ignored);
      return new Promise<void>(resolve => finishes.push(() => { nativeState = ignored; resolve(); }));
    });
    const first = writer.acquire();
    const initialHit = first.set(false);
    await Promise.resolve();
    finishes.shift()!();
    await initialHit;
    expect(nativeState).toBe(false);

    const release = first.release();
    await Promise.resolve();
    expect(calls).toEqual([false, true]);
    const visible = writer.acquire();
    const restoredHit = visible.set(false);
    await Promise.resolve();
    // The old native write is still pending; a second write must not overtake it.
    expect(calls).toEqual([false, true]);
    finishes.shift()!();
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual([false, true, false]);
    finishes.shift()!();
    await Promise.all([release, restoredHit]);
    expect(nativeState).toBe(false);

    await first.release();
    await first.set(true);
    await visible.set(false);
    expect(calls).toEqual([false, true, false]);
    expect(nativeState).toBe(false);
  });
});

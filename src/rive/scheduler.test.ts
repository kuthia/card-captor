import { describe, expect, it } from 'vitest';
import type { AnimationClock } from '../renderer/animation';
import type { RiveFrame } from './contract';
import { animateRive } from './scheduler';

function fakeClock() {
  let time = 0;
  let id = 0;
  const jobs = new Map<number, { at: number; work: () => void }>();
  const clock: AnimationClock = {
    now: () => time,
    schedule(work, delay) { const next = ++id; jobs.set(next, { at: time + delay, work }); return next; },
    cancel: id => { jobs.delete(id); },
  };
  const advance = (ms: number, stalled = false) => {
    const until = time + ms;
    if (stalled) time = until;
    for (;;) {
      const next = [...jobs.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > until) break;
      if (!stalled) time = next[1].at;
      jobs.delete(next[0]);
      next[1].work();
    }
    time = until;
  };
  return { clock, jobs, advance };
}

describe('Rive model clock', () => {
  it('animates all visible poses with only one bounded timer', () => {
    for (const state of ['idle', 'walk', 'dragging', 'browsing', 'suspended'] as const) {
      const { clock, jobs, advance } = fakeClock();
      const frames: RiveFrame[] = [];
      const stop = animateRive(frame => { frames.push(frame); return true; }, () => ({ state, direction: 1 }), false, clock, { elapsedMs: 0 });
      advance(1000);
      expect(frames).toHaveLength(30);
      expect(frames.at(-1)?.elapsedMs).toBe(986);
      expect(jobs.size).toBe(1);
      stop();
      expect(jobs.size).toBe(0);
    }
  });

  it('keeps accumulated time on state changes and excludes pause time', () => {
    const { clock, advance, jobs } = fakeClock();
    const frames: RiveFrame[] = [];
    const timeline = { elapsedMs: 0 };
    const draw = (frame: RiveFrame) => { frames.push(frame); return true; };
    const stop = animateRive(draw, () => ({ state: 'walk', direction: -1 }), false, clock, timeline);
    advance(340);
    stop();
    animateRive(draw, () => ({ state: 'browsing', direction: -1 }), true, clock, timeline);
    advance(60_000);
    expect(jobs.size).toBe(0);
    expect(frames.at(-1)).toMatchObject({ state: 'browsing', deltaSeconds: 0, elapsedMs: 340 });
    const resumed = animateRive(draw, () => ({ state: 'browsing', direction: 1 }), false, clock, timeline);
    advance(34);
    expect(frames.at(-1)).toMatchObject({ state: 'browsing', deltaSeconds: 0.034, elapsedMs: 374 });
    resumed();
  });

  it('bounds stalled time and stops after failure or cancellation', () => {
    const { clock, advance, jobs } = fakeClock();
    const frames: RiveFrame[] = [];
    const stop = animateRive(frame => { frames.push(frame); return true; }, () => ({ state: 'idle', direction: 1 }), false, clock, { elapsedMs: 0 });
    advance(5000, true);
    expect(frames.at(-1)?.deltaSeconds).toBe(0.1);
    stop();
    advance(1000);
    expect(frames).toHaveLength(2);
    animateRive(() => false, () => ({ state: 'idle', direction: 1 }), false, clock, { elapsedMs: 0 });
    expect(jobs.size).toBe(0);
  });
});

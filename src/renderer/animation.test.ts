import { describe, expect, it } from 'vitest';
import { animateCharacter, BLINK_DURATION_MS, IDLE_BLINK_AFTER_MS, type AnimationClock } from './animation';
import type { CharacterFrame } from './contract';

function fakeClock() {
  let time = 0;
  let nextId = 0;
  const pending = new Map<number, { callback: () => void; at: number }>();
  const clock: AnimationClock = {
    now: () => time,
    schedule(callback, delayMs) { const id = ++nextId; pending.set(id, { callback, at: time + delayMs }); return id; },
    cancel: id => { pending.delete(id); },
  };
  const advance = (elapsed: number) => {
    const end = time + elapsed;
    for (;;) {
      const next = [...pending.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) break;
      time = next[1].at;
      pending.delete(next[0]);
      next[1].callback();
    }
    time = end;
  };
  return { clock, advance, pending };
}

describe('character rendering wakeups', () => {
  it('resting and paused poses do not schedule frame loops', () => {
    for (const state of ['browsing', 'suspended', 'dragging'] as const) {
      const { clock, advance, pending } = fakeClock();
      const frames: CharacterFrame[] = [];
      const stop = animateCharacter(frame => { frames.push(frame); }, state, false, clock);
      advance(60_000);
      expect(frames).toHaveLength(1);
      expect(pending.size).toBe(0);
      stop();
    }
    const { clock, advance, pending } = fakeClock();
    const frames: CharacterFrame[] = [];
    animateCharacter(frame => { frames.push(frame); }, 'walk', true, clock);
    advance(60_000);
    expect(frames).toHaveLength(1);
    expect(pending.size).toBe(0);
  });

  it('an idle blink uses two one-shot redraws and can be canceled', () => {
    const { clock, advance, pending } = fakeClock();
    const frames: CharacterFrame[] = [];
    const stop = animateCharacter(frame => { frames.push(frame); }, 'idle', false, clock);
    advance(IDLE_BLINK_AFTER_MS - 1);
    expect(frames).toHaveLength(1);
    expect(pending.size).toBe(1);
    advance(1);
    expect(frames.at(-1)?.blink).toBe(true);
    advance(BLINK_DURATION_MS);
    expect(frames.at(-1)?.blink).toBe(false);
    expect(frames).toHaveLength(3);
    stop();
    advance(60_000);
    expect(frames).toHaveLength(3);
    expect(pending.size).toBe(0);
  });

  it('walking draws at 30 FPS and releases future work when stopped', () => {
    const { clock, advance, pending } = fakeClock();
    const frames: CharacterFrame[] = [];
    const stop = animateCharacter(frame => { frames.push(frame); }, 'walk', false, clock);
    advance(1000);
    expect(frames).toHaveLength(30);
    expect(pending.size).toBe(1);
    stop();
    const count = frames.length;
    advance(60_000);
    expect(frames).toHaveLength(count);
    expect(pending.size).toBe(0);
  });

  it('a renderer failure does not leave a retry loop running', () => {
    const { clock, advance, pending } = fakeClock();
    let count = 0;
    animateCharacter(() => { count += 1; return false; }, 'walk', false, clock);
    advance(60_000);
    expect(count).toBe(1);
    expect(pending.size).toBe(0);
  });
});

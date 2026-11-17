import type { MotionState } from '../motion';
import type { CharacterFrame } from './contract';

export interface AnimationClock {
  now(): number;
  schedule(callback: () => void, delayMs: number): number;
  cancel(id: number): void;
}

export const CHARACTER_FPS = 30;
// Browser timeouts use integer milliseconds; rounding down would exceed the cap.
export const CHARACTER_FRAME_MS = Math.ceil(1000 / CHARACTER_FPS);
export const IDLE_BLINK_AFTER_MS = 6000;
export const BLINK_DURATION_MS = 110;

/** One pending timeout at most. Resting poses have no continuous frame callback. */
export function animateCharacter(
  draw: (frame: CharacterFrame) => void | false,
  state: MotionState,
  paused: boolean,
  clock: AnimationClock,
): () => void {
  const startedAt = clock.now();
  let pending: number | null = null;
  let stopped = false;
  const stop = () => {
    stopped = true;
    if (pending !== null) clock.cancel(pending);
    pending = null;
  };
  const render = (blink: boolean) => {
    if (stopped) return false;
    if (draw({ state, elapsedMs: paused ? 0 : clock.now() - startedAt, blink }) === false) {
      stop();
      return false;
    }
    return true;
  };
  const later = (callback: () => void, delay: number) => {
    if (!stopped) pending = clock.schedule(() => { pending = null; callback(); }, delay);
  };
  const walk = () => {
    if (render(false)) later(walk, CHARACTER_FRAME_MS);
  };
  const blink = () => {
    if (!render(true)) return;
    later(() => {
      if (render(false)) later(blink, IDLE_BLINK_AFTER_MS);
    }, BLINK_DURATION_MS);
  };
  if (render(false) && !paused) {
    if (state === 'walk') later(walk, CHARACTER_FRAME_MS);
    else if (state === 'idle') later(blink, IDLE_BLINK_AFTER_MS);
  }
  return stop;
}

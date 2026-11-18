import type { AnimationClock } from '../renderer/animation';
import { CHARACTER_FRAME_MS } from '../renderer/animation';
import type { RiveFrame } from './contract';

export interface RiveTimeline { elapsedMs: number }
type Pose = Pick<RiveFrame, 'state' | 'direction'>;

/** Keep model time across intent changes; never catch up hidden or stalled time. */
export function animateRive(
  draw: (frame: RiveFrame) => boolean,
  pose: () => Pose,
  paused: boolean,
  clock: AnimationClock,
  timeline: RiveTimeline,
): () => void {
  let previous = clock.now();
  let pending: number | null = null;
  let stopped = false;
  const stop = () => {
    stopped = true;
    if (pending !== null) clock.cancel(pending);
    pending = null;
  };
  const step = (initial = false) => {
    if (stopped) return;
    pending = null;
    const now = clock.now();
    const deltaMs = initial || paused ? 0 : Math.max(0, Math.min(100, now - previous));
    previous = now;
    timeline.elapsedMs += deltaMs;
    if (!draw({ ...pose(), elapsedMs: timeline.elapsedMs, deltaSeconds: deltaMs / 1000 })) {
      stop();
      return;
    }
    if (!stopped && !paused) pending = clock.schedule(step, CHARACTER_FRAME_MS);
  };
  step(true);
  return stop;
}

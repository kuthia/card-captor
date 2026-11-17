import type { Point } from './geometry';

export type MotionState = 'idle' | 'walk' | 'dragging' | 'browsing' | 'suspended';
export interface MotionContext {
  dragging: boolean;
  browsing: boolean;
  suspended: boolean;
  hovered: boolean;
  walking: boolean;
}

export function motionState(context: MotionContext): MotionState {
  if (context.dragging) return 'dragging';
  if (context.browsing) return 'browsing';
  if (context.suspended) return 'suspended';
  return context.walking && !context.hovered ? 'walk' : 'idle';
}

/** Limit elapsed time so waking a hidden webview cannot teleport the companion. */
export function advanceRoam(position: Point, target: Point, elapsedMs: number, state: MotionState): Point {
  if (state !== 'walk') return position;
  const dx = target.x - position.x;
  const dy = target.y - position.y;
  const distance = Math.hypot(dx, dy);
  const step = Math.min(distance, Math.max(0, Math.min(elapsedMs, 100)) / 1000 * 35);
  if (distance === 0) return position;
  return { x: position.x + dx / distance * step, y: position.y + dy / distance * step };
}

import type { MotionState } from '../motion';

export interface RiveFrame {
  state: MotionState;
  deltaSeconds: number;
  elapsedMs: number;
  direction: -1 | 1;
}

/** A single canvas owns its runtime; scheduling and desktop movement stay outside. */
export interface RiveRuntime {
  readonly kind: 'rive';
  readonly animation: string;
  render(frame: RiveFrame): boolean;
  destroy(): void;
}

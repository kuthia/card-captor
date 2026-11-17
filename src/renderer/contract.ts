import type { MotionState } from '../motion';

export const CHARACTER_SIZE = { width: 168, height: 160 } as const;

export interface CharacterFrame {
  state: MotionState;
  elapsedMs: number;
  blink: boolean;
}

/** Cards and locomotion do not own the renderer's GPU resources or clock. */
export interface CharacterRenderer {
  readonly kind: 'webgl';
  /** False means no frame was drawn, for example while the WebGL context is lost. */
  render(frame: CharacterFrame): boolean;
  destroy(): void;
}

export type RendererStatus = 'initializing' | 'webgl' | 'svg-fallback' | 'context-lost';

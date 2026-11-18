import type { Artboard, File as RiveFile, LinearAnimationInstance, RiveCanvas } from '@rive-app/webgl2-advanced';
import type { MotionState } from '../motion';
import type { RiveFrame } from './contract';

/** Model-specific names, not newly authored reading/grab motions. */
export const SAMPLE_ANIMATIONS: Record<MotionState, string> = {
  idle: 'Idle', walk: 'Walk', dragging: 'Aim', browsing: 'Idle', suspended: 'Idle',
};
const BLINK_ANIMATION = 'Blink';
const TRACK_NAMES = [...new Set([...Object.values(SAMPLE_ANIMATIONS), 'WalkBack', BLINK_ANIMATION])];

interface PoseOwner {
  artboard: Artboard;
  tracks: Map<string, LinearAnimationInstance>;
}

function releasePose(pose: PoseOwner): void {
  for (const track of pose.tracks.values()) {
    try { track.delete(); } catch { /* Release the other independent owners. */ }
  }
  pose.tracks.clear();
  try { pose.artboard.delete(); } catch { /* Model ownership is retired regardless. */ }
}

function makePose(runtime: RiveCanvas, file: RiveFile, times = new Map<string, number>()): PoseOwner {
  // Background_tile is separate in the unchanged official sample.
  const artboard = file.artboardByName('Character');
  if (!artboard) throw new Error('Rive sample Character artboard is missing');
  const pose: PoseOwner = { artboard, tracks: new Map() };
  try {
    artboard.volume = 0;
    for (const name of TRACK_NAMES) {
      const definition = artboard.animationByName(name);
      if (!definition) throw new Error(`Rive sample animation is missing: ${name}`);
      const instance = new runtime.LinearAnimationInstance(definition, artboard);
      pose.tracks.set(name, instance);
      const time = times.get(name);
      if (time !== undefined) instance.time = time;
    }
    artboard.advance(0);
    return pose;
  } catch (error) { releasePose(pose); throw error; }
}

export interface SamplePose {
  readonly artboard: Artboard;
  readonly animation: string;
  update(frame: RiveFrame): void;
  destroy(): void;
}

/** Preserves timing while discarding action values absent from the next timeline. */
export function createSamplePose(runtime: RiveCanvas, file: RiveFile): SamplePose {
  let pose = makePose(runtime, file);
  let selected = 'Idle';
  let destroyed = false;
  return {
    get artboard() { return pose.artboard; },
    get animation() { return `${selected} + ${BLINK_ANIMATION}`; },
    update(frame) {
      if (destroyed) return;
      const next = frame.state === 'walk' && frame.direction < 0 ? 'WalkBack' : SAMPLE_ANIMATIONS[frame.state];
      if (next !== selected && selected !== 'Idle') {
        // Linear timelines leave unkeyed values behind. Clone only when leaving
        // an action, retaining the loaded file, GPU surface, and timeline phases.
        const times = new Map([...pose.tracks].map(([name, instance]) => [name, instance.time]));
        const replacement = makePose(runtime, file, times);
        const previous = pose;
        pose = replacement;
        releasePose(previous);
      }
      // Replay Aim once per grab, then hold its authored final pose until release.
      if (next === 'Aim' && next !== selected) pose.tracks.get(next)!.time = 0;
      selected = next;
      const delta = Number.isFinite(frame.deltaSeconds) ? Math.max(0, Math.min(frame.deltaSeconds, 0.1)) : 0;
      for (const name of new Set(['Idle', BLINK_ANIMATION, selected])) pose.tracks.get(name)!.advance(delta);
      pose.tracks.get('Idle')!.apply(1);
      if (selected !== 'Idle') pose.tracks.get(selected)!.apply(1);
      pose.tracks.get(BLINK_ANIMATION)!.apply(1);
      pose.artboard.advance(delta);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      releasePose(pose);
    },
  };
}

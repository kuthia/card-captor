import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import loadRive from '@rive-app/webgl2-advanced';
import { createSamplePose } from '../src/rive/sample-pose';
import type { RiveFrame } from '../src/rive/contract';

describe('pinned Rive sample and actual WASM compatibility', () => {
  it('loads the bundled Character artboard and exposes the timelines used by the app', async () => {
    const bytes = readFileSync('node_modules/@rive-app/webgl2-advanced/rive.wasm');
    const runtime = await loadRive({
      wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      locateFile: file => file,
    });
    const file = await runtime.load(new Uint8Array(readFileSync('public/rive/sample.riv')), undefined, false);
    const artboard = file.artboardByName('Character');
    const animations = [];
    try {
      for (let index = 0; index < artboard.animationCount(); index++) animations.push(artboard.animationByIndex(index).name);
      expect(animations).toEqual(['WalkBack', 'Aim', 'Idle', 'Walk', 'Fire', 'Blink', 'Idle_fire']);
      expect(artboard.bounds).toEqual({ minX: 0, minY: 0, maxX: 500, maxY: 500 });
      const animation = new runtime.LinearAnimationInstance(artboard.animationByName('Idle'), artboard);
      try {
        animation.advance(0.034);
        animation.apply(1);
        artboard.advance(0.034);
        expect(Number.isFinite(animation.time)).toBe(true);
      } finally { animation.delete(); }
      // Verify the actual SDK's boolean, rather than relying on its declarations:
      // a one-shot returns false at its end; this is not a "did loop" flag.
      const work = new runtime.LinearAnimationInstance(artboard.animationByName('Aim'), artboard);
      try {
        expect(work.advance(0.5)).toBe(true);
        expect(work.advance(10)).toBe(false);
        expect(work.time).toBeGreaterThan(2);
        work.time = 0;
        // Zero delta at the exact first key also returns false, but the pose
        // rewinds correctly and a positive delta resumes the same instance.
        expect(work.advance(0)).toBe(false);
        expect(work.time).toBe(0);
        expect(work.advance(0.034)).toBe(true);
      } finally { work.delete(); }
    } finally {
      artboard.delete();
      file.unref();
    }
  });

  it('returns from drag and both walking tracks to the fresh idle pose at the same model phase', async () => {
    const bytes = readFileSync('node_modules/@rive-app/webgl2-advanced/rive.wasm');
    const runtime = await loadRive({
      wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      locateFile: file => file,
    });
    const file = await runtime.load(new Uint8Array(readFileSync('public/rive/sample.riv')), undefined, false);
    const components = ['Ctrl_body', 'head', 'Body', 'chest', 'Ctrl_bow', 'Ctrl_arm_front', 'Ctrl_arm_back',
      'Leg_front_front', 'Leg_front_back', 'Leg_back_front', 'Leg_back_back'];
    const frame = (state: RiveFrame['state'], direction: -1 | 1): RiveFrame => ({ state, direction, deltaSeconds: 0.034, elapsedMs: 0 });
    try {
      for (const [state, direction] of [['dragging', 1], ['walk', 1], ['walk', -1]] as const) {
        const actual = createSamplePose(runtime, file);
        const baseline = createSamplePose(runtime, file);
        try {
          for (let index = 0; index < 110; index++) {
            actual.update(frame(index < 20 ? 'idle' : state, direction));
            baseline.update(frame('idle', direction));
          }
          const actionArtboard = actual.artboard;
          actual.update(frame('browsing', direction));
          baseline.update(frame('browsing', direction));
          expect(actual.artboard).not.toBe(actionArtboard);
          // Compare model transforms, not screenshots or a fake runtime. This
          // catches action properties absent from the idle timeline's keys.
          for (const name of components) {
            const got = actual.artboard.transformComponent(name).worldTransform();
            const expected = baseline.artboard.transformComponent(name).worldTransform();
            // Re-solving the rig's float32 constraints can differ by <0.001
            // artboard units after cloning (well below a display pixel).
            for (const key of ['xx', 'xy', 'yx', 'yy', 'tx', 'ty'] as const) expect(got[key]).toBeCloseTo(expected[key], 3);
          }
        } finally {
          actual.destroy();
          baseline.destroy();
        }
      }
    } finally { file.unref(); }
  });
});

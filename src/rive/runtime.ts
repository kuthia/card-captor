import loadRive, { type File as RiveFile, type RiveCanvas, type WrappedRenderer } from '@rive-app/webgl2-advanced';
import wasmUrl from '@rive-app/webgl2-advanced/rive.wasm?url';
import fallbackWasmUrl from '@rive-app/webgl2-advanced/rive_fallback.wasm?url';
import { CHARACTER_SIZE } from '../renderer/contract';
import type { RiveRuntime } from './contract';
import { createSamplePose, type SamplePose } from './sample-pose';

/** These names belong to the pinned centaur.riv Character artboard, not a universal schema. */
export { SAMPLE_ANIMATIONS } from './sample-pose';
const MODEL_URL = '/rive/sample.riv';
// The original 500×500 artboard includes empty padding. This view preserves the
// measured Character motion envelope, including the raised Aim arm, with margin.
export const SAMPLE_CONTENT_BOUNDS = { minX: 90, minY: 60, maxX: 450, maxY: 435 } as const;

// The SDK has module-owned shared GPU resources. Reuse one module for the app,
// and explicitly release each model/renderer when its canvas is retired.
let modulePromise: Promise<RiveCanvas> | null = null;
function riveModule(): Promise<RiveCanvas> {
  modulePromise ??= loadRive({
    locateFile: file => file.endsWith('rive_fallback.wasm') ? fallbackWasmUrl : wasmUrl,
  }).catch(error => { modulePromise = null; throw error; });
  return modulePromise;
}

function checkCanceled(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Rive initialization canceled', 'AbortError');
}

/** No timers, RAF, DOM listeners, or native input ownership: the host supplies every frame. */
export async function createRiveRuntime(canvas: HTMLCanvasElement, signal: AbortSignal): Promise<RiveRuntime> {
  checkCanceled(signal);
  const runtime = await riveModule();
  checkCanceled(signal);
  const resolution = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  canvas.width = Math.round(CHARACTER_SIZE.width * resolution);
  canvas.height = Math.round(CHARACTER_SIZE.height * resolution);
  const context = canvas.getContext('webgl2', {
    alpha: true, depth: true, stencil: true, antialias: true,
    premultipliedAlpha: true, preserveDrawingBuffer: false,
    powerPreference: 'low-power', failIfMajorPerformanceCaveat: true,
  });
  if (!context) throw new Error('Rive requires WebGL2');

  let renderer: WrappedRenderer | null = null;
  let file: RiveFile | null = null;
  let pose: SamplePose | null = null;
  let destroyed = false;
  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    // A lost context must not prevent the remaining WASM objects from being freed.
    const release = (action: () => void) => { try { action(); } catch { /* Continue releasing independent owners. */ } };
    release(() => renderer?.bindContext?.());
    release(() => pose?.destroy());
    pose = null;
    release(() => file?.unref());
    file = null;
    release(() => renderer?.delete());
    renderer = null;
    release(() => context.getExtension('WEBGL_lose_context')?.loseContext());
  };

  try {
    // false gives this canvas its own WebGL surface, rather than copying from
    // the SDK's offscreen renderer into a Canvas2D surface.
    renderer = runtime.makeRenderer(canvas, false);
    if (!renderer) throw new Error('Rive renderer could not be created');
    const response = await fetch(MODEL_URL, { signal, credentials: 'same-origin' });
    if (!response.ok) throw new Error('Rive sample could not be loaded');
    const bytes = new Uint8Array(await response.arrayBuffer());
    checkCanceled(signal);
    // Embedded assets only: do not enable the SDK's automatic asset CDN loader.
    file = await runtime.load(bytes, undefined, false);
    checkCanceled(signal);
    if (!file || file.artboardCount() === 0) throw new Error('Rive sample contains no artboard');
    pose = createSamplePose(runtime, file);

    return {
      kind: 'rive',
      get animation() { return pose?.animation ?? 'Idle + Blink'; },
      render(frame) {
        if (destroyed || !renderer || !pose || context.isContextLost()) return false;
        pose.update(frame);
        renderer.clear();
        renderer.save();
        renderer.align(runtime.Fit.contain, runtime.Alignment.center, {
          minX: 0, minY: 0, maxX: canvas.width, maxY: canvas.height,
        }, SAMPLE_CONTENT_BOUNDS);
        pose.artboard.draw(renderer);
        renderer.restore();
        renderer.flush();
        // Required by the SDK when the host owns the animation clock.
        runtime.resolveAnimationFrame();
        return true;
      },
      destroy,
    };
  } catch (error) {
    destroy();
    throw error;
  }
}

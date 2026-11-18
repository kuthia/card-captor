import { useEffect, useRef, useState, type RefObject } from 'react';
import type { MotionState } from './motion';
import { ROBOT_BODY, ROBOT_EYES, ROBOT_SHADOW } from './renderer/art';
import { CHARACTER_SIZE } from './renderer/contract';
import { RendererLifetime } from './renderer/lifetime';
import type { AnimationClock } from './renderer/animation';
import type { RiveRuntime } from './rive/contract';
import { animateRive } from './rive/scheduler';

const clock: AnimationClock = {
  now: () => performance.now(),
  schedule: (callback, delay) => window.setTimeout(callback, delay),
  cancel: id => window.clearTimeout(id),
};
type Status = 'initializing' | 'rive' | 'context-lost' | 'svg-fallback';

/** React owns lifecycle, the runtime owns drawing, and App owns desktop input. */
export function RiveCharacter({ state, count, paused, direction }: {
  state: MotionState;
  count: number;
  paused: boolean;
  direction: RefObject<-1 | 1>;
}) {
  const hostRef = useRef<HTMLSpanElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const lifetimeRef = useRef<RendererLifetime<RiveRuntime> | null>(null);
  const poseRef = useRef({ state, paused });
  poseRef.current = { state, paused };
  const timelineRef = useRef({ elapsedMs: 0 });
  const framesRef = useRef(0);
  const [status, setStatus] = useState<Status>('initializing');
  const [restart, setRestart] = useState(0);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const controller = new AbortController();
    const lifetime = new RendererLifetime<RiveRuntime>();
    lifetimeRef.current = lifetime;
    timelineRef.current = { elapsedMs: 0 };
    framesRef.current = 0;
    setStatus('initializing');
    const lost = (event: Event) => {
      event.preventDefault();
      if (!controller.signal.aborted) setStatus('context-lost');
    };
    // Rive resources belong to this context. Recreate both canvas and model.
    const restored = () => { if (!controller.signal.aborted) setRestart(value => value + 1); };
    canvas.addEventListener('webglcontextlost', lost);
    canvas.addEventListener('webglcontextrestored', restored);
    import('./rive/runtime').then(module => module.createRiveRuntime(canvas, controller.signal)).then(runtime => {
      if (!lifetime.attach(runtime)) return;
      setStatus('rive');
      setGeneration(value => value + 1);
    }).catch(() => {
      if (!controller.signal.aborted) setStatus('svg-fallback');
    });
    return () => {
      controller.abort();
      canvas.removeEventListener('webglcontextlost', lost);
      canvas.removeEventListener('webglcontextrestored', restored);
      lifetime.dispose();
      if (lifetimeRef.current === lifetime) lifetimeRef.current = null;
    };
  }, [restart]);

  useEffect(() => {
    const lifetime = lifetimeRef.current;
    const runtime = lifetime?.current;
    if (!runtime || status !== 'rive') return;
    return animateRive(frame => {
      if (!lifetime.isCurrent(runtime)) return false;
      try {
        if (!runtime.render(frame)) { setStatus('context-lost'); return false; }
        framesRef.current += 1;
        if (hostRef.current) {
          hostRef.current.dataset.frameCount = String(framesRef.current);
          hostRef.current.dataset.animation = runtime.animation;
          hostRef.current.dataset.modelTimeMs = String(Math.round(frame.elapsedMs));
        }
        return true;
      } catch {
        lifetime.retire(runtime);
        setStatus('svg-fallback');
        return false;
      }
    }, () => ({ state: poseRef.current.state, direction: direction.current }), paused, clock, timelineRef.current);
  }, [direction, generation, paused, state, status]);

  return <span ref={hostRef} className="robot" data-renderer={status}
    title={status === 'rive' ? 'Rive WebGL2 · Centaur 공식 샘플' : status === 'initializing' ? 'Rive 모델 준비 중' : 'Rive를 표시하지 못해 기본 정지 이미지를 표시합니다.'}
    style={{ position: 'relative', width: CHARACTER_SIZE.width, height: CHARACTER_SIZE.height }} aria-hidden="true">
    <canvas key={restart} ref={canvasRef} width={CHARACTER_SIZE.width} height={CHARACTER_SIZE.height}
      style={{ display: 'block', width: CHARACTER_SIZE.width, height: CHARACTER_SIZE.height, visibility: status === 'rive' ? 'visible' : 'hidden', pointerEvents: 'none' }} />
    {status !== 'rive' && <svg viewBox="0 0 168 160" fill="none" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
      <g dangerouslySetInnerHTML={{ __html: ROBOT_SHADOW + ROBOT_BODY + ROBOT_EYES }} />
    </svg>}
    {count > 0 && <svg viewBox="0 0 168 160" fill="none" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
      <circle cx="140" cy="58" r="12" fill="#343934" stroke="#FFFAEF" strokeWidth="2" />
      <text x="140" y="62" textAnchor="middle" fill="#FFFAEF" fontSize="10" fontFamily="system-ui" fontWeight="700">{count > 99 ? '99+' : count}</text>
    </svg>}
  </span>;
}

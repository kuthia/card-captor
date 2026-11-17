import { useEffect, useRef, useState } from 'react';
import type { MotionState } from './motion';
import { animateCharacter, type AnimationClock } from './renderer/animation';
import { ROBOT_BODY, ROBOT_EYES, ROBOT_SHADOW } from './renderer/art';
import { CHARACTER_SIZE, type CharacterRenderer, type RendererStatus } from './renderer/contract';
import { RendererLifetime } from './renderer/lifetime';

const clock: AnimationClock = {
  now: () => performance.now(),
  schedule: (callback, delayMs) => window.setTimeout(callback, delayMs),
  cancel: id => window.clearTimeout(id),
};

const rendererLabels: Record<RendererStatus, string> = {
  initializing: '캐릭터 렌더러 준비 중',
  webgl: 'WebGL 캐릭터 렌더러 · 저전력 GPU 선호 힌트',
  'svg-fallback': '정적 SVG 대체 · WebGL을 사용할 수 없음',
  'context-lost': '정적 SVG 대체 · WebGL 컨텍스트 복구 대기',
};

/** Richer character formats can replace the renderer without owning cards or movement. */
export function Robot({ state, count, paused = false }: { state: MotionState; count: number; paused?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const lifetimeRef = useRef<RendererLifetime<CharacterRenderer> | null>(null);
  const poseRef = useRef({ state, paused });
  poseRef.current = { state, paused };
  const [status, setStatus] = useState<RendererStatus>('initializing');
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const controller = new AbortController();
    const lifetime = new RendererLifetime<CharacterRenderer>();
    lifetimeRef.current = lifetime;
    let instance: CharacterRenderer | null = null;
    const lost = (event: Event) => {
      event.preventDefault();
      if (!controller.signal.aborted && lifetime.isCurrent(instance)) setStatus('context-lost');
    };
    const restored = () => {
      // Pixi's own context-restored listener must rebuild resources before drawing.
      queueMicrotask(() => {
        if (controller.signal.aborted || !lifetime.isCurrent(instance)) return;
        try {
          if (!instance.render({ state: poseRef.current.state, elapsedMs: 0, blink: false })) {
            setStatus('context-lost');
            return;
          }
          setStatus('webgl');
          setGeneration(value => value + 1);
        } catch {
          lifetime.retire(instance);
          setStatus('svg-fallback');
        }
      });
    };
    canvas.addEventListener('webglcontextlost', lost);
    canvas.addEventListener('webglcontextrestored', restored);
    import('./renderer/pixi').then(module => module.createCharacterRenderer(canvas, controller.signal)).then(renderer => {
      instance = renderer;
      if (!lifetime.attach(renderer)) return;
      try {
        if (!renderer.render({ state: poseRef.current.state, elapsedMs: 0, blink: false })) {
          setStatus('context-lost');
          return;
        }
      }
      catch { lifetime.retire(renderer); setStatus('svg-fallback'); return; }
      setStatus('webgl');
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
  }, []);

  useEffect(() => {
    const lifetime = lifetimeRef.current;
    const renderer = lifetime?.current;
    if (!renderer || status !== 'webgl') return;
    return animateCharacter(frame => {
      if (!lifetime.isCurrent(renderer)) return false;
      try {
        if (!renderer.render(frame)) {
          setStatus('context-lost');
          return false;
        }
      }
      catch {
        setStatus('svg-fallback');
        lifetime.retire(renderer);
        return false;
      }
    }, state, paused, clock);
  }, [generation, paused, state, status]);

  return <span className="robot" style={{ position: 'relative', width: CHARACTER_SIZE.width, height: CHARACTER_SIZE.height }}
    data-renderer={status} title={rendererLabels[status]} aria-hidden="true">
    <canvas ref={canvasRef} width={CHARACTER_SIZE.width} height={CHARACTER_SIZE.height}
      style={{ display: 'block', width: CHARACTER_SIZE.width, height: CHARACTER_SIZE.height, visibility: status === 'webgl' ? 'visible' : 'hidden', pointerEvents: 'none' }} />
    {status !== 'webgl' && <svg viewBox="0 0 168 160" fill="none" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
      <g dangerouslySetInnerHTML={{ __html: ROBOT_SHADOW }} />
      <g transform={state === 'dragging' && !paused ? 'rotate(-7 75 140) translate(0 -5)' : undefined}
        dangerouslySetInnerHTML={{ __html: ROBOT_BODY + ROBOT_EYES }} />
    </svg>}
    {count > 0 && <svg viewBox="0 0 168 160" fill="none" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
      <circle cx="140" cy="58" r="12" fill="#343934" stroke="#FFFAEF" strokeWidth="2" />
      <text x="140" y="62" textAnchor="middle" fill="#FFFAEF" fontSize="10" fontFamily="system-ui" fontWeight="700">{count > 99 ? '99+' : count}</text>
    </svg>}
  </span>;
}

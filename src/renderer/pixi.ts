// This polyfill replaces Pixi's dynamic code generation; CSP stays free of unsafe-eval.
import 'pixi.js/unsafe-eval';
import { Container, Graphics, Sprite, Texture, WebGLRenderer } from 'pixi.js';
import { CHARACTER_SIZE, type CharacterRenderer } from './contract';
import { robotTextureSvg } from './art';
import { getCharacter, type CharacterId } from '../characters';

function loadImage(source: string, signal: AbortSignal): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const cleanup = () => {
      image.onload = null;
      image.onerror = null;
      signal.removeEventListener('abort', abort);
    };
    const abort = () => {
      cleanup();
      image.src = '';
      reject(new DOMException('Character initialization canceled', 'AbortError'));
    };
    image.onload = () => { cleanup(); resolve(image); };
    image.onerror = () => { cleanup(); reject(new Error('Character texture could not be loaded')); };
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    image.src = source;
  });
}

/** A small dedicated WebGL surface. No Application, shared ticker, or fullscreen canvas. */
export async function createCharacterRenderer(canvas: HTMLCanvasElement, signal: AbortSignal, characterId: CharacterId = 'robot'): Promise<CharacterRenderer> {
  if (signal.aborted) throw new DOMException('Character initialization canceled', 'AbortError');
  const resolution = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  const context = canvas.getContext('webgl2', {
    alpha: true, antialias: false, depth: false, stencil: true,
    premultipliedAlpha: true, preserveDrawingBuffer: false,
    powerPreference: 'low-power', failIfMajorPerformanceCaveat: true,
  });
  if (!context) throw new Error('WebGL2 unavailable');
  const renderer = new WebGLRenderer();
  const stage = new Container();
  const figure = new Container();
  let texture: Texture | null = null;
  let image: HTMLImageElement | null = null;
  let destroyed = false;

  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    stage.destroy({ children: true });
    texture?.destroy(true);
    texture = null;
    if (image) image.src = '';
    image = null;
    // Safe if async initialization failed after registering the scheduler listener.
    renderer.scheduler?.destroy();
    try { renderer.destroy({ removeView: false, releaseGlobalResources: false }); }
    catch { context.getExtension('WEBGL_lose_context')?.loseContext(); }
  };

  try {
    await renderer.init({
      canvas, context, width: CHARACTER_SIZE.width, height: CHARACTER_SIZE.height,
      resolution, autoDensity: true, backgroundAlpha: 0,
      antialias: false, powerPreference: 'low-power', gcActive: false,
      eventMode: 'none', eventFeatures: { move: false, globalMove: false, click: false, wheel: false },
    });
    // The renderer scheduler itself subscribes to Ticker.system. Fixed assets have
    // explicit ownership, so periodic GC and synthetic pointer events are unnecessary.
    renderer.scheduler.destroy();
    if (renderer.events) {
      // Pixi 8.23's public API supports null to unbind, although its declaration omits it.
      const unbind = renderer.events.setTargetElement.bind(renderer.events) as (element: HTMLElement | null) => void;
      unbind(null);
    }
    if (signal.aborted) throw new DOMException('Character initialization canceled', 'AbortError');
    const character = getCharacter(characterId);
    image = await loadImage(character.image ?? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(robotTextureSvg(resolution))}`, signal);
    if (signal.aborted) throw new DOMException('Character initialization canceled', 'AbortError');
    texture = Texture.from(image);
    const body = new Sprite(texture);
    const fit = Math.min(CHARACTER_SIZE.width / image.naturalWidth, CHARACTER_SIZE.height / image.naturalHeight);
    body.width = image.naturalWidth * fit;
    body.height = image.naturalHeight * fit;
    body.position.set((CHARACTER_SIZE.width - body.width) / 2, (CHARACTER_SIZE.height - body.height) / 2);
    figure.pivot.set(75, 140);
    figure.position.set(75, 140);
    figure.addChild(body);
    const eyes = new Graphics().roundRect(58, 54, 7, 11, 3.5).roundRect(83, 54, 7, 11, 3.5).fill(0xb8d8b5);
    eyes.pivot.set(74, 60);
    eyes.position.set(74, 60);
    eyes.visible = characterId === 'robot';
    figure.addChild(eyes);
    const antenna = new Graphics().circle(75, 17, 3.7).fill(0xaecbad);
    antenna.visible = false;
    figure.addChild(antenna);
    const shadow = new Graphics().ellipse(77, 146, 43, 6).fill({ color: 0x343934, alpha: 0.12 });
    stage.eventMode = 'none';
    stage.addChild(shadow, figure);
    return {
      kind: 'webgl',
      render(frame) {
        if (destroyed || context.isContextLost()) return false;
        const walking = frame.state === 'walk';
        const phase = frame.elapsedMs / 580 * Math.PI * 2;
        figure.rotation = frame.state === 'dragging' ? -0.12 : walking ? Math.sin(phase) * 0.018 : 0;
        figure.y = 140 + (frame.state === 'dragging' ? -5 : walking ? -Math.abs(Math.sin(phase)) * 3 : 0);
        eyes.scale.y = frame.blink ? 0.12 : 1;
        antenna.visible = characterId === 'robot' && frame.state === 'browsing';
        renderer.render({ container: stage, clear: true });
        return true;
      },
      destroy,
    };
  } catch (error) { destroy(); throw error; }
}

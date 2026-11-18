import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RiveFrame } from './contract';

const fixture = vi.hoisted(() => {
  const instances: { name: string; time: number; advance: ReturnType<typeof vi.fn>; apply: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> }[] = [];
  const artboard = {
    volume: 1,
    bounds: { minX: 0, minY: 0, maxX: 500, maxY: 500 },
    animationByName: vi.fn((name: string) => ({ name, loopValue: name === 'Aim' ? 0 : 1 })),
    advance: vi.fn(), draw: vi.fn(), delete: vi.fn(),
  };
  const file = { artboardCount: () => 1, artboardByName: vi.fn(() => artboard), unref: vi.fn() };
  const renderer = {
    bindContext: vi.fn(), clear: vi.fn(), save: vi.fn(), align: vi.fn(), restore: vi.fn(), flush: vi.fn(), delete: vi.fn(),
  };
  const runtime = {
    makeRenderer: vi.fn(() => renderer), load: vi.fn(async () => file),
    LinearAnimationInstance: vi.fn(function (definition: { name: string }) {
      const instance = { name: definition.name, time: 0, advance: vi.fn(() => true), apply: vi.fn(), delete: vi.fn() };
      instances.push(instance);
      return instance;
    }),
    Fit: { contain: 'contain' }, Alignment: { center: 'center' }, resolveAnimationFrame: vi.fn(),
  };
  return { instances, artboard, file, renderer, runtime };
});

vi.mock('@rive-app/webgl2-advanced', () => ({ default: vi.fn(async () => fixture.runtime) }));
vi.mock('@rive-app/webgl2-advanced/rive.wasm?url', () => ({ default: '/assets/rive.wasm' }));
vi.mock('@rive-app/webgl2-advanced/rive_fallback.wasm?url', () => ({ default: '/assets/rive_fallback.wasm' }));
import { createRiveRuntime } from './runtime';

function surface() {
  const loseContext = vi.fn();
  const context = { isContextLost: vi.fn(() => false), getExtension: vi.fn(() => ({ loseContext })) };
  const canvas = { width: 168, height: 160, getContext: vi.fn(() => context) };
  return { canvas: canvas as unknown as HTMLCanvasElement, context, loseContext };
}
const frame = (state: RiveFrame['state'], deltaSeconds = 0.034): RiveFrame => ({ state, deltaSeconds, elapsedMs: 100, direction: 1 });

beforeEach(() => {
  vi.clearAllMocks();
  fixture.instances.length = 0;
  fixture.runtime.load.mockResolvedValue(fixture.file);
  fixture.artboard.animationByName.mockImplementation(name => ({ name, loopValue: name === 'Aim' ? 0 : 1 }));
  fixture.artboard.volume = 1;
  vi.stubGlobal('window', { devicePixelRatio: 3 });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) })));
});
afterEach(() => vi.unstubAllGlobals());

describe('Rive model lifetime and rendering', () => {
  it('uses local resources and keeps file/GPU owners across action pose resets', async () => {
    const { canvas } = surface();
    const runtime = await createRiveRuntime(canvas, new AbortController().signal);
    expect([canvas.width, canvas.height]).toEqual([336, 320]);
    expect(fixture.runtime.makeRenderer).toHaveBeenCalledWith(canvas, false);
    expect(fixture.runtime.load).toHaveBeenCalledWith(expect.any(Uint8Array), undefined, false);
    expect(fetch).toHaveBeenCalledWith('/rive/sample.riv', expect.objectContaining({ credentials: 'same-origin' }));
    expect(fixture.artboard.volume).toBe(0);
    for (const state of ['idle', 'walk', 'dragging', 'browsing', 'suspended'] as const) expect(runtime.render(frame(state))).toBe(true);
    expect(fixture.file.artboardByName).toHaveBeenCalledWith('Character');
    expect(fixture.instances).toHaveLength(15);
    expect(fixture.instances.slice(0, 10).every(instance => instance.delete.mock.calls.length === 1)).toBe(true);
    expect(fixture.instances.slice(10).every(instance => instance.delete.mock.calls.length === 0)).toBe(true);
    expect(fixture.runtime.makeRenderer).toHaveBeenCalledOnce();
    expect(fixture.runtime.load).toHaveBeenCalledOnce();
    expect(runtime.animation).toBe('Idle + Blink');
    expect(fixture.renderer.flush).toHaveBeenCalledTimes(5);
    expect(fixture.runtime.resolveAnimationFrame).toHaveBeenCalledTimes(5);
    runtime.destroy();
  });

  it('clamps a resumed delta and selects the authored backwards walk', async () => {
    const { canvas } = surface();
    const runtime = await createRiveRuntime(canvas, new AbortController().signal);
    const walk = fixture.instances.find(instance => instance.name === 'WalkBack')!;
    runtime.render({ ...frame('walk', 10), direction: -1 });
    expect(walk.advance).toHaveBeenLastCalledWith(0.1);
    expect(runtime.animation).toBe('WalkBack + Blink');
    runtime.render({ ...frame('walk', Number.NaN), direction: -1 });
    expect(walk.advance).toHaveBeenLastCalledWith(0);
    runtime.destroy();
  });

  it('starts a drag response only on grab, holds it, and leaves idle/blink clocks alone', async () => {
    const { canvas } = surface();
    const runtime = await createRiveRuntime(canvas, new AbortController().signal);
    const aim = fixture.instances.find(instance => instance.name === 'Aim')!;
    const idle = fixture.instances.find(instance => instance.name === 'Idle')!;
    idle.time = 9;
    aim.time = 8;
    runtime.render(frame('dragging'));
    expect(aim.time).toBe(0);
    expect(idle.time).toBe(9);
    aim.time = 2;
    aim.advance.mockReturnValue(false);
    runtime.render(frame('dragging'));
    expect(aim.time).toBe(2);
    runtime.render(frame('browsing'));
    expect(aim.advance).toHaveBeenCalledTimes(2);
    expect(aim.delete).toHaveBeenCalledOnce();
    const restoredIdle = fixture.instances.filter(instance => instance.name === 'Idle').at(-1)!;
    expect(restoredIdle.time).toBe(9);
    runtime.render(frame('dragging'));
    const freshAim = fixture.instances.filter(instance => instance.name === 'Aim').at(-1)!;
    expect(freshAim.time).toBe(0);
    expect(runtime.animation).toBe('Aim + Blink');
    runtime.destroy();
  });

  it('releases a failed replacement while retaining the current pose until host teardown', async () => {
    const { canvas } = surface();
    const runtime = await createRiveRuntime(canvas, new AbortController().signal);
    runtime.render(frame('walk'));
    const brokenArtboard = {
      ...fixture.artboard,
      animationByName: vi.fn((name: string) => {
        if (name === 'Walk') throw new Error('Replacement failed');
        return { name, loopValue: 1 };
      }),
      delete: vi.fn(),
    };
    fixture.file.artboardByName.mockReturnValueOnce(brokenArtboard);
    expect(() => runtime.render(frame('browsing'))).toThrow('Replacement failed');
    expect(brokenArtboard.delete).toHaveBeenCalledOnce();
    expect(fixture.instances.at(-1)!.delete).toHaveBeenCalledOnce();
    expect(fixture.instances.slice(0, 5).every(instance => instance.delete.mock.calls.length === 0)).toBe(true);
    expect(fixture.artboard.delete).not.toHaveBeenCalled();
    expect(fixture.file.unref).not.toHaveBeenCalled();
    runtime.destroy();
    expect(fixture.instances.every(instance => instance.delete.mock.calls.length === 1)).toBe(true);
    expect(fixture.artboard.delete).toHaveBeenCalledOnce();
    expect(fixture.file.unref).toHaveBeenCalledOnce();
    expect(fixture.renderer.delete).toHaveBeenCalledOnce();
  });

  it('releases a model that finishes loading after cancellation', async () => {
    const { canvas, loseContext } = surface();
    let finish!: (file: typeof fixture.file) => void;
    fixture.runtime.load.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const controller = new AbortController();
    const loading = createRiveRuntime(canvas, controller.signal);
    await vi.waitFor(() => expect(fixture.runtime.load).toHaveBeenCalledOnce());
    controller.abort();
    finish(fixture.file);
    await expect(loading).rejects.toMatchObject({ name: 'AbortError' });
    expect(fixture.file.unref).toHaveBeenCalledOnce();
    expect(fixture.artboard.delete).not.toHaveBeenCalled();
    expect(fixture.renderer.delete).toHaveBeenCalledOnce();
    expect(loseContext).toHaveBeenCalledOnce();
  });

  it('cleans up an incomplete model and rejects unsupported sample metadata', async () => {
    const { canvas } = surface();
    fixture.artboard.animationByName.mockImplementation(name => {
      if (name === 'Walk') throw new Error('Missing Walk');
      return { name, loopValue: 1 };
    });
    await expect(createRiveRuntime(canvas, new AbortController().signal)).rejects.toThrow('Missing Walk');
    expect(fixture.instances).toHaveLength(1);
    expect(fixture.instances[0].delete).toHaveBeenCalledOnce();
    expect(fixture.artboard.delete).toHaveBeenCalledOnce();
    expect(fixture.file.unref).toHaveBeenCalledOnce();
    expect(fixture.renderer.delete).toHaveBeenCalledOnce();
  });

  it('stops drawing on context loss and destroys each owner once even if teardown fails', async () => {
    const { canvas, context, loseContext } = surface();
    const runtime = await createRiveRuntime(canvas, new AbortController().signal);
    context.isContextLost.mockReturnValue(true);
    expect(runtime.render(frame('idle'))).toBe(false);
    expect(fixture.renderer.clear).not.toHaveBeenCalled();
    fixture.instances[0].delete.mockImplementationOnce(() => { throw new Error('Lost GL context'); });
    runtime.destroy();
    runtime.destroy();
    expect(fixture.instances.every(instance => instance.delete.mock.calls.length === 1)).toBe(true);
    expect(fixture.artboard.delete).toHaveBeenCalledOnce();
    expect(fixture.file.unref).toHaveBeenCalledOnce();
    expect(fixture.renderer.delete).toHaveBeenCalledOnce();
    expect(loseContext).toHaveBeenCalledOnce();
    expect(runtime.render(frame('idle'))).toBe(false);
  });
});

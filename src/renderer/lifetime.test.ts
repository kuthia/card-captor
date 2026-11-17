import { describe, expect, it } from 'vitest';
import { RendererLifetime } from './lifetime';

function resource() {
  const history: string[] = [];
  return { history, destroy: () => { history.push('destroyed'); } };
}

describe('async character renderer ownership', () => {
  it('releases a renderer that finishes initialization after unmount', async () => {
    const lifetime = new RendererLifetime<ReturnType<typeof resource>>();
    const renderer = resource();
    let finish!: (value: typeof renderer) => void;
    const initialized = new Promise<typeof renderer>(resolve => { finish = resolve; });
    const pending = initialized.then(value => lifetime.attach(value));
    lifetime.dispose();
    finish(renderer);
    expect(await pending).toBe(false);
    expect(renderer.history).toEqual(['destroyed']);
    expect(lifetime.current).toBeNull();
    expect(lifetime.isCurrent(renderer)).toBe(false);
  });

  it('does not promote a failed renderer when its old context later restores', () => {
    const lifetime = new RendererLifetime<ReturnType<typeof resource>>();
    const failed = resource();
    const replacement = resource();
    lifetime.attach(failed);
    lifetime.retire(failed);
    lifetime.attach(replacement);
    const eligibleRestores = [failed, replacement].filter(value => lifetime.isCurrent(value));
    expect(eligibleRestores).toEqual([replacement]);
    expect(failed.history).toEqual(['destroyed']);
    lifetime.dispose();
  });

  it('failure, cleanup, and repeated cleanup release a resource once', () => {
    const lifetime = new RendererLifetime<ReturnType<typeof resource>>();
    const renderer = resource();
    lifetime.attach(renderer);
    lifetime.retire(renderer);
    lifetime.retire(renderer);
    lifetime.dispose();
    lifetime.dispose();
    expect(renderer.history).toEqual(['destroyed']);
  });
});

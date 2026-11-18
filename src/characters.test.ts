import { afterEach, describe, expect, it, vi } from 'vitest';
import { readPreviewCharacter, savePreviewCharacter } from './characters';

afterEach(() => vi.unstubAllGlobals());

describe('browser character preference', () => {
  it('restores a selection on reload and replaces it when switching back', () => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
    expect(readPreviewCharacter()).toBe('robot');
    savePreviewCharacter('welluni');
    expect(readPreviewCharacter()).toBe('welluni');
    savePreviewCharacter('robot');
    expect(readPreviewCharacter()).toBe('robot');
  });

  it('recovers from invalid or unavailable storage without accepting arbitrary asset paths', () => {
    vi.stubGlobal('localStorage', { getItem: () => 'https://untrusted.test/pet.svg' });
    expect(readPreviewCharacter()).toBe('robot');
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('full'); },
    });
    expect(readPreviewCharacter()).toBe('robot');
    expect(() => savePreviewCharacter('welluni')).toThrow('캐릭터를 저장하지 못했어요');
    expect(readPreviewCharacter()).toBe('robot');
  });
});

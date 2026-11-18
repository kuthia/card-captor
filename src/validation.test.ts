import { expect, it, vi } from 'vitest';
import { parseCharacterValidation, validationSetup } from './validation';

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke, isTauri: () => true }));

it('accepts only the immutable native validation schema', () => {
  expect(parseCharacterValidation(Object.freeze({ version: 1, backend: 'rive' }))).toBe(true);
  for (const value of [null, true, 'true', [], {}, { version: '1' }, { version: 2 },
    { version: 1 }, { version: 1, backend: 'live2d' }, { version: 1, backend: 'rive', token: 'synthetic' }, { version: 1, state: 'cards' }]) {
    expect(parseCharacterValidation(value)).toBe(false);
  }
  expect(parseCharacterValidation(Object.assign(Object.create({ backend: 'rive' }), { version: 1, unknown: true }))).toBe(false);
});

it('keeps interactive cards detached and disables authenticated refresh', () => {
  const first = validationSetup();
  const second = validationSetup();
  expect(first).toEqual(second);
  expect(first.hasToken).toBe(false);
  expect(first.config.viewId).toBe('');
  expect(first.config.roamingEnabled).toBe(true);
  expect(first.snapshot?.cards).toHaveLength(6);
  expect(first.snapshot?.cards.every(card => card.url === '' && card.statusColor)).toBe(true);
  first.config.roamingEnabled = false;
  first.snapshot!.cards.pop();
  expect(second.config.roamingEnabled).toBe(true);
  expect(second.snapshot?.cards).toHaveLength(6);
});

it('keeps validation provider reads local and rejects every external action', async () => {
  vi.resetModules();
  native.invoke.mockClear();
  vi.stubGlobal('window', { __CARD_CAPTOR_CHARACTER_VALIDATION__: { version: 1, backend: 'rive' } });
  try {
    const { provider } = await import('./provider');
    expect(await provider.getSetup()).toEqual(validationSetup());
    expect(await provider.refresh()).toEqual(validationSetup().snapshot);
    for (const request of [
      () => provider.saveSetup(validationSetup().config, null),
      () => provider.setCharacterBackend('rive'),
      () => provider.setCharacter('welluni'),
      () => provider.disconnect(),
      () => provider.openCard('synthetic-card'),
      () => provider.getCardStatus('synthetic-card'),
      () => provider.updateCardStatus('synthetic-card', 'field', 'option'),
    ]) {
      await expect(request()).rejects.toThrow('검증 모드');
    }
    expect(native.invoke).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
    vi.resetModules();
  }
});

it('keeps Codex observation, preferences, alerts, and URI opening isolated during Rive validation', async () => {
  vi.resetModules();
  native.invoke.mockClear();
  vi.stubGlobal('window', { __CARD_CAPTOR_CHARACTER_VALIDATION__: { version: 1, backend: 'rive' } });
  try {
    const { codex } = await import('./codex');
    const before = await codex.get();
    const stop = await codex.subscribe(() => { throw new Error('unexpected event'); });
    codex.simulate('running');
    expect(await codex.get()).toEqual(before);
    await expect(codex.save({ enabled: true, notifications: true, sound: true })).rejects.toThrow('검증');
    await codex.open('synthetic-card');
    await codex.testAlert();
    stop();
    expect(native.invoke).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
    vi.resetModules();
  }
});

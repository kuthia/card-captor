import { expect, it } from 'vitest';
import { measurementSetup, parseMeasurementConfig, seededMeasurementRandom } from './benchmark';

it('accepts only the native measurement schema and whitelisted states', () => {
  for (const state of ['idle', 'moving', 'cards']) {
    expect(parseMeasurementConfig({ version: 1, state, cardCount: 20 })?.state).toBe(state);
  }
  for (const value of [null, 'idle', { version: 2, state: 'idle', cardCount: 20 },
    { version: 1, state: 'normal', cardCount: 20 }, { version: 1, state: 'cards', cardCount: 0 }]) {
    expect(parseMeasurementConfig(value)).toBeNull();
  }
});

it('uses identical detached fixtures without enabling authenticated refresh', () => {
  const first = measurementSetup();
  const second = measurementSetup();
  expect(first.snapshot?.cards).toHaveLength(20);
  expect(first).toEqual(second);
  expect(first.hasToken).toBe(false);
  expect(first.config.viewId).toBe('');
  first.snapshot!.cards.pop();
  expect(second.snapshot?.cards).toHaveLength(20);
});

it('makes the movement target sequence reproducible', () => {
  const a = seededMeasurementRandom();
  const b = seededMeasurementRandom();
  const sequence = Array.from({ length: 8 }, () => a());
  expect(sequence).toEqual(Array.from({ length: 8 }, () => b()));
  expect(new Set(sequence).size).toBe(8);
  expect(sequence.every(value => value >= 0 && value < 1)).toBe(true);
});

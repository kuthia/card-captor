import { describe, expect, it } from 'vitest';
import { clampPoint, containsPoint, physicalToLocal, placePanel } from './geometry';
import { advanceRoam, motionState } from './motion';

describe('desktop interaction geometry', () => {
  it('maps a Retina display left of the primary display into CSS hit regions', () => {
    const cursor = physicalToLocal({ x: -2100, y: 380 }, { x: -2880, y: 100 }, 2);
    expect(cursor).toEqual({ x: 390, y: 140 });
    expect(containsPoint(cursor, { left: 350, top: 100, right: 450, bottom: 200 })).toBe(true);
    expect(containsPoint({ x: 349, y: 140 }, { left: 350, top: 100, right: 450, bottom: 200 })).toBe(false);
  });

  it('keeps a dragged character above the dock and inside the work area', () => {
    expect(clampPoint({ x: 1500, y: 920 }, { width: 168, height: 180 }, { left: 0, top: 28, right: 1440, bottom: 836 }))
      .toEqual({ x: 1260, y: 644 });
  });

  it('keeps a deck reachable when the character is at a screen edge', () => {
    const bounds = { left: 0, top: 24, right: 900, bottom: 700 };
    const panel = { width: 352, height: 410 };
    const position = placePanel({ x: 10, y: 40 }, { width: 168, height: 180 }, panel, bounds);
    expect(position.x).toBeGreaterThanOrEqual(bounds.left);
    expect(position.y).toBeGreaterThanOrEqual(bounds.top);
    expect(position.x + panel.width).toBeLessThanOrEqual(bounds.right);
    expect(position.y + panel.height).toBeLessThanOrEqual(bounds.bottom);
  });
});

describe('companion interaction priorities', () => {
  const moving = { dragging: false, browsing: false, suspended: false, hovered: false, walking: true };

  it('stops movement while cards are read, even if a walk target already exists', () => {
    const state = motionState({ ...moving, browsing: true });
    expect(state).toBe('browsing');
    expect(advanceRoam({ x: 20, y: 30 }, { x: 500, y: 300 }, 50, state)).toEqual({ x: 20, y: 30 });
  });

  it('lets manual dragging work while roaming is paused', () => {
    expect(motionState({ ...moving, suspended: true, dragging: true })).toBe('dragging');
  });

  it('does not teleport after a suspended animation frame or overshoot a target', () => {
    expect(advanceRoam({ x: 0, y: 0 }, { x: 500, y: 0 }, 90_000, 'walk').x).toBe(3.5);
    expect(advanceRoam({ x: 0, y: 0 }, { x: 1, y: 0 }, 100, 'walk')).toEqual({ x: 1, y: 0 });
  });
});

export interface Point { x: number; y: number }
export interface Size { width: number; height: number }
export interface Bounds { left: number; top: number; right: number; bottom: number }

export function clampPoint(point: Point, size: Size, bounds: Bounds, margin = 12): Point {
  const left = bounds.left + margin;
  const top = bounds.top + margin;
  return {
    x: Math.max(left, Math.min(point.x, Math.max(left, bounds.right - size.width - margin))),
    y: Math.max(top, Math.min(point.y, Math.max(top, bounds.bottom - size.height - margin))),
  };
}

/** Both desktop positions are physical; DOM hit regions are local CSS pixels. */
export function physicalToLocal(cursor: Point, origin: Point, scaleFactor: number): Point {
  if (!Number.isFinite(scaleFactor) || scaleFactor <= 0) throw new Error('Invalid display scale');
  return { x: (cursor.x - origin.x) / scaleFactor, y: (cursor.y - origin.y) / scaleFactor };
}

export function containsPoint(point: Point, rect: Bounds, padding = 0): boolean {
  return point.x >= rect.left - padding && point.x <= rect.right + padding
    && point.y >= rect.top - padding && point.y <= rect.bottom + padding;
}

export function placePanel(pet: Point, petSize: Size, panel: Size, bounds: Bounds): Point {
  const above = pet.y - panel.height - 8;
  const below = pet.y + petSize.height + 8;
  const fitsAbove = above >= bounds.top + 12;
  const fitsBelow = below + panel.height <= bounds.bottom - 12;
  // A tall deck near the screen center must not cover the character's drag target.
  if (!fitsAbove && !fitsBelow) {
    const right = pet.x + petSize.width + 12;
    const left = pet.x - panel.width - 12;
    const side = right + panel.width <= bounds.right - 12 ? right
      : left >= bounds.left + 12 ? left : null;
    if (side !== null) return clampPoint({ x: side, y: pet.y + (petSize.height - panel.height) / 2 }, panel, bounds);
  }
  return clampPoint({
    x: pet.x + petSize.width / 2 - panel.width / 2,
    y: fitsAbove ? above : below,
  }, panel, bounds);
}

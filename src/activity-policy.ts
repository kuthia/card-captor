import { clampPoint, containsPoint, type Bounds, type Point, type Size } from './geometry';
import { advanceRoam, motionState, type MotionContext, type MotionState } from './motion';

export const WALK_INTERVAL_MS = Math.ceil(1000 / 30);
export const POINTER_NEAR_MS = 50;
export const POINTER_FAR_MS = 250;

/** Outside interaction regions, wake less often without changing the hit-test boundary. */
export function pointerPollDelay(cursor: Point, regions: Bounds[], dragging: boolean): number {
  return dragging || regions.some(region => containsPoint(cursor, region, 96))
    ? POINTER_NEAR_MS : POINTER_FAR_MS;
}

interface RoamOptions {
  context: Omit<MotionContext, 'walking'>;
  size: Size;
  position(): Point;
  bounds(): Bounds;
  move(point: Point, finished: boolean): void;
  state(value: MotionState): void;
  now?: () => number;
  random?: () => number;
  /** Measurement-only cadence; movement and frame calculation remain identical. */
  continuous?: boolean;
}

/** Resting uses one deadline; blocked activity owns no animation timer. */
export function startRoaming(options: RoamOptions): () => void {
  const { context } = options;
  options.state(motionState({ ...context, walking: false }));
  if (context.dragging || context.browsing || context.suspended || context.hovered) return () => {};

  const now = options.now ?? (() => performance.now());
  const random = options.random ?? Math.random;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  let previous = 0;
  let target: Point;

  const schedule = (work: () => void, delay: number) => {
    timer = setTimeout(() => { if (!stopped) work(); }, delay);
  };
  const walk = () => {
    const timestamp = now();
    const next = clampPoint(
      advanceRoam(options.position(), target, timestamp - previous, 'walk'),
      options.size, options.bounds(), 18,
    );
    previous = timestamp;
    const finished = Math.hypot(next.x - target.x, next.y - target.y) < 1;
    options.move(next, finished);
    if (finished) {
      if (!options.continuous) options.state('idle');
      schedule(startWalk, options.continuous ? 0 : 2500 + random() * 4500);
    } else schedule(walk, WALK_INTERVAL_MS);
  };
  const startWalk = () => {
    const bounds = options.bounds();
    target = clampPoint({
      x: bounds.left + random() * Math.max(0, bounds.right - bounds.left - options.size.width),
      y: bounds.top + random() * Math.max(0, bounds.bottom - bounds.top - options.size.height),
    }, options.size, bounds, 18);
    previous = now();
    options.state('walk');
    schedule(walk, WALK_INTERVAL_MS);
  };
  schedule(startWalk, options.continuous ? 0 : 3500);
  return () => { stopped = true; clearTimeout(timer); };
}

/** Chain after completion so slow native calls can never overlap. */
export function startAdaptivePolling(options: {
  enabled: boolean;
  poll(): Promise<number>;
}): () => void {
  if (!options.enabled) return () => {};
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const step = async () => {
    let delay = POINTER_FAR_MS;
    try { delay = await options.poll(); } catch { /* Caller reports native failures. */ }
    if (!stopped) timer = setTimeout(() => void step(), Math.max(POINTER_NEAR_MS, delay));
  };
  void step();
  return () => { stopped = true; clearTimeout(timer); };
}

/** One native input owner across React effect lifetimes; the newest lease wins. */
export class CursorInputWriter {
  private epoch = 0;
  private desired = true;
  private applied: boolean | null = null;
  private running: Promise<void> | null = null;

  constructor(private readonly write: (ignored: boolean) => Promise<void>) {}

  acquire(): { set(ignored: boolean): Promise<void>; release(): Promise<void> } {
    const epoch = ++this.epoch;
    return {
      set: ignored => epoch === this.epoch ? this.request(ignored) : Promise.resolve(),
      release: () => {
        if (epoch !== this.epoch) return Promise.resolve();
        this.epoch += 1;
        return this.request(true);
      },
    };
  }

  private request(ignored: boolean): Promise<void> {
    this.desired = ignored;
    if (this.running) return this.running;
    this.running = Promise.resolve().then(async () => {
      try {
        while (this.applied !== this.desired) {
          const next = this.desired;
          try {
            await this.write(next);
            this.applied = next;
          } catch (error) {
            this.applied = null;
            throw error;
          }
        }
      } finally {
        // Clear in this job, without a later Promise.finally gap losing a new intent.
        this.running = null;
      }
    });
    return this.running;
  }
}

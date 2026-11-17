interface DisposableRenderer { destroy(): void }

/** Invalidates ownership before releasing resources, including late async initialization. */
export class RendererLifetime<T extends DisposableRenderer> {
  private renderer: T | null = null;
  private disposed = false;

  get current(): T | null { return this.renderer; }

  attach(renderer: T): boolean {
    if (this.disposed) { renderer.destroy(); return false; }
    const previous = this.renderer;
    this.renderer = renderer;
    if (previous !== renderer) previous?.destroy();
    return true;
  }

  isCurrent(renderer: T | null): renderer is T {
    return !this.disposed && renderer !== null && this.renderer === renderer;
  }

  retire(renderer: T): boolean {
    if (!this.isCurrent(renderer)) return false;
    this.renderer = null;
    renderer.destroy();
    return true;
  }

  dispose(): void {
    this.disposed = true;
    const renderer = this.renderer;
    this.renderer = null;
    renderer?.destroy();
  }
}

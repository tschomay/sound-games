/** A canvas that fills its parent and stays sharp on high-density screens. */
export interface Surface {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  /** CSS pixels — draw in these; the DPR scale is already applied. */
  width: number;
  height: number;
  dispose(): void;
}

export function createSurface(parent: HTMLElement): Surface {
  const canvas = document.createElement('canvas');
  canvas.className = 'surface';
  parent.appendChild(canvas);

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser does not support 2D canvas.');

  const surface: Surface = { canvas, ctx, width: 0, height: 0, dispose };

  const resize = (): void => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = parent.getBoundingClientRect();
    surface.width = Math.max(1, Math.round(rect.width));
    surface.height = Math.max(1, Math.round(rect.height));
    canvas.width = Math.round(surface.width * dpr);
    canvas.height = Math.round(surface.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  const observer = new ResizeObserver(resize);
  observer.observe(parent);
  resize();

  function dispose(): void {
    observer.disconnect();
    canvas.remove();
  }

  return surface;
}

/** requestAnimationFrame loop with a delta clamped against tab-switch spikes. */
export function startLoop(step: (dt: number) => void): () => void {
  let handle = 0;
  let last = performance.now();
  let running = true;

  const tick = (now: number): void => {
    if (!running) return;
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    step(dt);
    handle = requestAnimationFrame(tick);
  };
  handle = requestAnimationFrame(tick);

  return () => {
    running = false;
    cancelAnimationFrame(handle);
  };
}

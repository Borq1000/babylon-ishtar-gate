// Frame timing + dynamic resolution controller.

export class FrameStats {
  samples: number[] = [];
  fps = 60;
  frameMs = 16.7;

  push(dtMs: number): void {
    // ignore throttled / hidden-tab frames and one-off hitches (shader compiles)
    if (dtMs > 100 || (typeof document !== 'undefined' && document.hidden)) return;
    this.samples.push(dtMs);
    if (this.samples.length > 90) this.samples.shift();
    const sorted = [...this.samples].sort((a, b) => a - b);
    // use a high percentile so hitches count
    this.frameMs = sorted[Math.floor(sorted.length * 0.75)] ?? dtMs;
    this.fps = 1000 / this.frameMs;
  }

  reset(): void {
    this.samples.length = 0;
  }
}

/** Adjusts a render-scale factor to keep the frame time near the target. */
export class DynamicResolution {
  scale: number;
  private timer = 0;
  enabled = true;

  constructor(
    public min: number,
    public max: number,
    private targetMs = 17.5,
  ) {
    this.scale = max;
  }

  setBounds(min: number, max: number): void {
    this.min = min;
    this.max = max;
    this.scale = Math.min(Math.max(this.scale, min), max);
  }

  /** Returns true if the scale changed. */
  update(dt: number, stats: FrameStats): boolean {
    if (!this.enabled) return false;
    if (dt > 0.1) return false;
    this.timer += dt;
    if (this.timer < 1.2 || (stats as unknown as { samples: number[] }).samples.length < 30) return false;
    this.timer = 0;
    const ms = stats.frameMs;
    let next = this.scale;
    if (ms > this.targetMs * 1.18) next -= ms > this.targetMs * 1.7 ? 0.1 : 0.05;
    else if (ms < this.targetMs * 0.97) next += 0.04;
    next = Math.min(this.max, Math.max(this.min, Math.round(next * 100) / 100));
    if (Math.abs(next - this.scale) > 0.001) {
      this.scale = next;
      stats.reset();
      return true;
    }
    return false;
  }
}

/**
 * Deterministic PRNG (mulberry32) plus helpers for humanised timing and choices.
 * Every generator gets its own forked stream, so behaviour is varied but repeatable
 * and one busy emitter never changes the "dice rolls" of another.
 */
export class Rng {
  private state: number;

  constructor(seed = 0xbab575) {
    this.state = seed >>> 0 || 0x9e3779b9;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  /** Integer in [min, max] (inclusive). */
  int(min: number, max: number): number {
    return Math.floor(min + (max - min + 1) * this.next());
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)] as T;
  }

  /** Pick from [value, weight] pairs. */
  weighted<T>(items: readonly (readonly [T, number])[]): T {
    let total = 0;
    for (const [, w] of items) total += w;
    let r = this.next() * total;
    for (const [v, w] of items) {
      r -= w;
      if (r <= 0) return v;
    }
    return (items[items.length - 1] as readonly [T, number])[0];
  }

  /** Triangular jitter in [-amount, amount]; small deviations are the most likely. */
  jitter(amount: number): number {
    return (this.next() - this.next()) * amount;
  }

  /** `value` scaled by a random factor within ±spread (relative). */
  vary(value: number, spread: number): number {
    return value * (1 + this.jitter(spread));
  }

  /** Approximately normal (mean 0, sd 1), naturally bounded to about ±3.5. */
  gauss(): number {
    return (this.next() + this.next() + this.next() + this.next() - 2) * 1.7320508;
  }

  /** Exponential interval with the given mean (Poisson spacing), capped at 5x the mean. */
  exp(mean: number): number {
    return Math.min(-Math.log(1 - this.next()) * mean, mean * 5);
  }

  /** Independent child stream (e.g. one per emitter or per voice). */
  fork(salt = 0): Rng {
    const s = (Math.floor(this.next() * 4294967296) ^ Math.imul(salt + 0x51ed, 0x9e3779b1)) >>> 0;
    return new Rng(s);
  }
}

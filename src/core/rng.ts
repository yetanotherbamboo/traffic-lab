/** Small, fast, seedable PRNG (mulberry32). Use this instead of Math.random() for anything reproducible. */
export class Rng {
  private s: number;

  constructor(seed: number) {
    this.s = seed >>> 0 || 1;
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)]!;
  }

  /** Picks a key by relative weight. */
  weighted<K extends string>(weights: Readonly<Record<K, number>>): K {
    const entries = Object.entries(weights) as [K, number][];
    let r = this.next() * entries.reduce((s, [, w]) => s + w, 0);
    for (const [k, w] of entries) {
      r -= w;
      if (r < 0) return k;
    }
    return entries[entries.length - 1]![0];
  }
}

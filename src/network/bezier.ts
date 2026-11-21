import type { Vec3 } from '../core/math';

const LUT_SIZE = 64;

/** Cubic Bezier in 3D with an arc-length table for constant-speed sampling. */
export class CubicBezier {
  readonly length: number;
  private readonly lut = new Float64Array(LUT_SIZE + 1); // cumulative length at t = i / LUT_SIZE

  constructor(
    readonly p0: Vec3,
    readonly p1: Vec3,
    readonly p2: Vec3,
    readonly p3: Vec3,
  ) {
    let prev = this.point(0);
    for (let i = 1; i <= LUT_SIZE; i++) {
      const p = this.point(i / LUT_SIZE);
      this.lut[i] = this.lut[i - 1]! + Math.hypot(p[0] - prev[0], p[1] - prev[1], p[2] - prev[2]);
      prev = p;
    }
    this.length = this.lut[LUT_SIZE]!;
  }

  /** Straight line expressed as a Bezier (control points at 1/3 and 2/3). */
  static line(a: Vec3, b: Vec3): CubicBezier {
    const lerp = (t: number): Vec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    return new CubicBezier(a, lerp(1 / 3), lerp(2 / 3), b);
  }

  point(t: number): Vec3 {
    const u = 1 - t;
    const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
    const { p0, p1, p2, p3 } = this;
    return [
      a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0],
      a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1],
      a * p0[2] + b * p1[2] + c * p2[2] + d * p3[2],
    ];
  }

  /** Splits the curve at parameter t into two curves (de Casteljau). */
  split(t: number): [CubicBezier, CubicBezier] {
    const l = (a: Vec3, b: Vec3): Vec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    const { p0, p1, p2, p3 } = this;
    const a = l(p0, p1), b = l(p1, p2), c = l(p2, p3);
    const d = l(a, b), e = l(b, c);
    const m = l(d, e);
    return [new CubicBezier(p0, a, d, m), new CubicBezier(m, e, c, p3)];
  }

  /** First derivative (not normalized). */
  derivative(t: number): Vec3 {
    const u = 1 - t;
    const a = 3 * u * u, b = 6 * u * t, c = 3 * t * t;
    const { p0, p1, p2, p3 } = this;
    return [
      a * (p1[0] - p0[0]) + b * (p2[0] - p1[0]) + c * (p3[0] - p2[0]),
      a * (p1[1] - p0[1]) + b * (p2[1] - p1[1]) + c * (p3[1] - p2[1]),
      a * (p1[2] - p0[2]) + b * (p2[2] - p1[2]) + c * (p3[2] - p2[2]),
    ];
  }

  /** Parameter t at arc length s (clamped to [0, length]). */
  tAtDistance(s: number): number {
    if (s <= 0) return 0;
    if (s >= this.length) return 1;
    let lo = 0, hi = LUT_SIZE;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.lut[mid]! < s) lo = mid;
      else hi = mid;
    }
    const l0 = this.lut[lo]!, l1 = this.lut[hi]!;
    return (lo + (s - l0) / (l1 - l0)) / LUT_SIZE;
  }

  /** Total turning (radians, in the ground plane) between arc lengths s0 and s1. */
  turning(s0 = 0, s1 = this.length): number {
    const t0 = this.tAtDistance(s0), t1 = this.tAtDistance(s1);
    const N = 24;
    let total = 0, px = 0, pz = 0;
    for (let i = 0; i <= N; i++) {
      const d = this.derivative(t0 + ((t1 - t0) * i) / N);
      if (i > 0) total += Math.abs(Math.atan2(px * d[2] - pz * d[0], px * d[0] + pz * d[2]));
      px = d[0];
      pz = d[2];
    }
    return total;
  }

  /** Number of pieces to sample [s0, s1] with: at most `step` metres and `maxTurn` radians each. */
  pieces(s0: number, s1: number, step: number, maxTurn = (6 * Math.PI) / 180): number {
    return Math.max(1, Math.ceil((s1 - s0) / step), Math.ceil(this.turning(s0, s1) / maxTurn));
  }

  /** True when both control points lie on the line through the end points (within `tol` metres). */
  straight(tol = 0.05): boolean {
    const { p0, p1, p2, p3 } = this;
    const dx = p3[0] - p0[0], dz = p3[2] - p0[2];
    const l = Math.hypot(dx, dz);
    if (l < 1e-6) return false;
    const off = (p: Vec3): number => Math.abs((p[0] - p0[0]) * dz - (p[2] - p0[2]) * dx) / l;
    return off(p1) <= tol && off(p2) <= tol;
  }
}

import type { Vec3 } from '../core/math';

/** Polyline with cumulative arc length. Sampling is allocation-free (writes into `out`). */
export class Path {
  readonly pts: Float32Array; // x, y, z per point
  readonly cum: Float32Array; // arc length at each point
  readonly length: number;

  constructor(points: Vec3[]) {
    if (points.length < 2) throw new Error('Path needs at least 2 points');
    this.pts = new Float32Array(points.length * 3);
    this.cum = new Float32Array(points.length);
    points.forEach((p, i) => this.pts.set(p, i * 3));
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1]!, b = points[i]!;
      this.cum[i] = this.cum[i - 1]! + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    }
    this.length = Math.max(this.cum[points.length - 1]!, 1e-3);
  }

  get count(): number {
    return this.cum.length;
  }

  point(i: number): Vec3 {
    return [this.pts[i * 3]!, this.pts[i * 3 + 1]!, this.pts[i * 3 + 2]!];
  }

  /** Unit horizontal direction at the start / end of the path. */
  dirAt(end: boolean): Vec3 {
    const n = this.count;
    const a = this.point(end ? n - 2 : 0), b = this.point(end ? n - 1 : 1);
    const dx = b[0] - a[0], dz = b[2] - a[2];
    const l = Math.hypot(dx, dz) || 1;
    return [dx / l, 0, dz / l];
  }

  /** Closest point on the path to (x, z) in the ground plane: arc length and distance. */
  project(x: number, z: number): { s: number; dist: number } {
    const pts = this.pts, cum = this.cum;
    let bestS = 0, bestD = Infinity;
    for (let i = 0; i + 1 < cum.length; i++) {
      const ax = pts[i * 3]!, az = pts[i * 3 + 2]!;
      const dx = pts[i * 3 + 3]! - ax, dz = pts[i * 3 + 5]! - az;
      const l2 = dx * dx + dz * dz;
      const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2)) : 0;
      const d = Math.hypot(x - (ax + dx * t), z - (az + dz * t));
      if (d < bestD) [bestD, bestS] = [d, cum[i]! + t * (cum[i + 1]! - cum[i]!)];
    }
    return { s: bestS, dist: bestD };
  }

  /**
   * Writes [x, y, z, heading] at arc length s into `out` (offset `o`).
   * Heading follows the instance-rotation convention: atan2(-dz, dx).
   */
  sample(s: number, out: Float32Array, o = 0): void {
    const cum = this.cum, pts = this.pts;
    const n = cum.length;
    if (s <= 0) s = 0;
    if (s >= this.length) s = this.length;
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (cum[mid]! <= s) lo = mid;
      else hi = mid;
    }
    const seg = cum[hi]! - cum[lo]!;
    const t = seg > 0 ? (s - cum[lo]!) / seg : 0;
    const ax = pts[lo * 3]!, ay = pts[lo * 3 + 1]!, az = pts[lo * 3 + 2]!;
    const bx = pts[hi * 3]!, by = pts[hi * 3 + 1]!, bz = pts[hi * 3 + 2]!;
    out[o] = ax + (bx - ax) * t;
    out[o + 1] = ay + (by - ay) * t;
    out[o + 2] = az + (bz - az) * t;
    out[o + 3] = Math.atan2(-(bz - az), bx - ax);
  }
}

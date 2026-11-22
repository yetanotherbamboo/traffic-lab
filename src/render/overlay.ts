import type { Vec3 } from '../core/math';
import { KIND_EMISSIVE, LIT_STRIDE, type Lot } from '../env/city';
import type { CubicBezier } from '../network/bezier';

const Y = 0.24; // just above sidewalks

/**
 * Editor overlay drawn with the box kit as unlit, self-coloured instances: strips along roads,
 * rings for snap points, outlines for buildings about to be demolished. One draw call.
 */
export class OverlayBuilder {
  private data = new Float32Array(LIT_STRIDE * 512);
  count = 0;

  clear(): void {
    this.count = 0;
  }

  get buffer(): Float32Array {
    return this.data;
  }

  private box(x: number, y: number, z: number, heading: number, sx: number, sy: number, sz: number, c: Vec3): void {
    if ((this.count + 1) * LIT_STRIDE > this.data.length) {
      const bigger = new Float32Array(this.data.length * 2);
      bigger.set(this.data);
      this.data = bigger;
    }
    const o = this.count * LIT_STRIDE, d = this.data;
    d[o] = x; d[o + 1] = y; d[o + 2] = z; d[o + 3] = heading;
    d[o + 4] = sx; d[o + 5] = sy; d[o + 6] = sz;
    d[o + 7] = c[0]; d[o + 8] = c[1]; d[o + 9] = c[2];
    d[o + 10] = KIND_EMISSIVE;
    this.count++;
  }

  /** Flat strip from a to b, `y` above their (average) height: on the ground, or on a raised road. */
  strip(a: Vec3, b: Vec3, width: number, c: Vec3, y = Y): void {
    const dx = b[0] - a[0], dz = b[2] - a[2];
    const len = Math.hypot(dx, dz);
    if (len < 1e-3) return;
    this.box((a[0] + b[0]) / 2, (a[1] + b[1]) / 2 + y, (a[2] + b[2]) / 2, Math.atan2(-dz, dx), len + width * 0.3, 0.04, width, c);
  }

  /** Strip following a curve between arc lengths s0 and s1, offset sideways by `side` metres. */
  curve(curve: CubicBezier, c: Vec3, width = 0.8, s0 = 0, s1 = curve.length, side = 0): void {
    const n = Math.max(1, Math.ceil((s1 - s0) / 3));
    let prev: Vec3 | null = null;
    for (let k = 0; k <= n; k++) {
      const t = curve.tAtDistance(s0 + ((s1 - s0) * k) / n);
      let p = curve.point(t);
      if (side !== 0) {
        const d = curve.derivative(t), l = Math.hypot(d[0], d[2]) || 1;
        p = [p[0] - (d[2] / l) * side, p[1], p[2] + (d[0] / l) * side];
      }
      if (prev) this.strip(prev, p, width, c);
      prev = p;
    }
  }

  /**
   * Chevron arrows along a curve pointing towards its end (or its start if `reverse`), offset
   * sideways by `side` metres to the right of the curve's own direction.
   */
  arrows(curve: CubicBezier, c: Vec3, side: number, spacing = 9, s0 = 0, s1 = curve.length, reverse = false): void {
    for (let s = s0 + spacing / 2; s < s1; s += spacing) {
      const t = curve.tAtDistance(s);
      const p = curve.point(t), d = curve.derivative(t), l = Math.hypot(d[0], d[2]) || 1;
      const dx = d[0] / l, dz = d[2] / l;
      const x = p[0] - dz * side, z = p[2] + dx * side;
      const h = reverse ? Math.atan2(dz, -dx) : Math.atan2(-dz, dx);
      for (const sgn of [1, -1]) {
        const a = h + sgn * 2.4; // arms sweep back from the tip
        this.box(x + Math.cos(a) * 0.55, p[1] + Y, z - Math.sin(a) * 0.55, a, 1.2, 0.04, 0.3, c);
      }
    }
  }

  ring(p: Vec3, r: number, c: Vec3, width = 0.45): void {
    const n = Math.max(12, Math.ceil(r * 1.5));
    for (let k = 0; k < n; k++) {
      const a0 = (k / n) * Math.PI * 2, a1 = ((k + 1) / n) * Math.PI * 2;
      this.strip([p[0] + Math.cos(a0) * r, p[1], p[2] + Math.sin(a0) * r], [p[0] + Math.cos(a1) * r, p[1], p[2] + Math.sin(a1) * r], width, c, Y + 0.02);
    }
  }

  dot(p: Vec3, size: number, c: Vec3): void {
    this.box(p[0], p[1] + Y + 0.03, p[2], Math.PI / 4, size, 0.05, size, c);
  }

  /** Outline of a lot rectangle (raised so it shows above lawns). */
  lot(l: Lot, c: Vec3): void {
    const cs = Math.cos(l.angle), sn = Math.sin(l.angle);
    const corner = (u: number, v: number): Vec3 => [l.cx + cs * u + sn * v, 0, l.cz - sn * u + cs * v];
    const pts = [corner(-l.hx, -l.hz), corner(l.hx, -l.hz), corner(l.hx, l.hz), corner(-l.hx, l.hz)];
    for (let k = 0; k < 4; k++) this.strip(pts[k]!, pts[(k + 1) % 4]!, 0.6, c, 0.4);
  }
}

import type { Vec3 } from '../core/math';
import type { CubicBezier } from '../network/bezier';
import type { LaneProfile } from '../network/network';
import { MAX_LAT_ACCEL } from '../sim/laneGraph';

/** How the Road tool shapes a new road between its start and end. */
export type DrawMode = 'straight' | 'curve' | 'continuous';

/** Cubic Bezier control points of a road from A to B. */
export interface Shape {
  c1: Vec3;
  c2: Vec3;
}

/** Continuous mode: the end may lie at most this far off the start direction (the arc sweeps twice that). */
export const MAX_CONTINUE = (75 * Math.PI) / 180;
export const TOO_SHARP = 'Too sharp a turn to continue the road: end it further ahead';

const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => [a[0] + (b[0] - a[0]) * t, 0, a[2] + (b[2] - a[2]) * t];

/** Straight road: control points at a third and two thirds. */
export function straightShape(A: Vec3, B: Vec3): Shape {
  return { c1: lerp(A, B, 1 / 3), c2: lerp(A, B, 2 / 3) };
}

/** Unit vector to the right of the chord A → B (forward lanes' side), or null if A ≈ B. */
function chordRight(A: Vec3, B: Vec3): Vec3 | null {
  const dx = B[0] - A[0], dz = B[2] - A[2];
  const l = Math.hypot(dx, dz);
  return l < 1e-6 ? null : [-dz / l, 0, dx / l];
}

/** The point a curved road passes through halfway: the chord's midpoint pushed `bend` metres to its right. */
export function bendPoint(A: Vec3, B: Vec3, bend: number): Vec3 {
  const mid = lerp(A, B, 0.5), r = chordRight(A, B);
  return r ? [mid[0] + r[0] * bend, 0, mid[2] + r[2] * bend] : mid;
}

/** Signed distance (m) of `p` to the right of the chord A → B: the `bend` that puts the middle at p. */
export function bendFrom(A: Vec3, B: Vec3, p: Vec3): number {
  const r = chordRight(A, B);
  if (!r) return 0;
  const mid = lerp(A, B, 0.5);
  return (p[0] - mid[0]) * r[0] + (p[2] - mid[2]) * r[2];
}

/**
 * Curve mode: a smooth bow through `bendPoint(A, B, bend)` (a quadratic curve written as a
 * cubic, the same shape the Bend tool makes).
 */
export function curveShape(A: Vec3, B: Vec3, bend: number): Shape {
  if (Math.abs(bend) < 0.05) return straightShape(A, B);
  const mid = lerp(A, B, 0.5), H = bendPoint(A, B, bend);
  const Q: Vec3 = [2 * H[0] - mid[0], 0, 2 * H[2] - mid[2]];
  return { c1: lerp(A, Q, 2 / 3), c2: lerp(B, Q, 2 / 3) };
}

/**
 * Continuous mode: a circular arc that leaves A along the unit direction `dir` (the road it
 * continues) and ends at B, so the two roads join without a kink. Returns an error message when B
 * is too far round to the side or behind.
 */
export function continueShape(A: Vec3, B: Vec3, dir: Vec3): Shape | string {
  const cx = B[0] - A[0], cz = B[2] - A[2];
  const L = Math.hypot(cx, cz);
  if (L < 1e-6) return straightShape(A, B);
  const ux = cx / L, uz = cz / L;
  const cos = Math.max(-1, Math.min(1, dir[0] * ux + dir[2] * uz));
  const phi = Math.acos(cos); // angle between the start direction and the chord
  if (phi < 0.005) return straightShape(A, B);
  if (phi > MAX_CONTINUE) return TOO_SHARP;
  // Arc sweeping 2·phi with radius R; cubic handles of (4/3)·tan(sweep/4)·R approximate it closely.
  const R = L / (2 * Math.sin(phi));
  const k = (4 / 3) * Math.tan(phi / 2) * R;
  // End direction: the start direction mirrored in the chord.
  const ex = 2 * cos * ux - dir[0], ez = 2 * cos * uz - dir[2];
  return {
    c1: [A[0] + dir[0] * k, 0, A[2] + dir[2] * k],
    c2: [B[0] - ex * k, 0, B[2] - ez * k],
  };
}

/** Unit direction a shaped road arrives at B with (for chaining the next road). */
export function endDirection(A: Vec3, B: Vec3, s: Shape): Vec3 {
  let dx = B[0] - s.c2[0], dz = B[2] - s.c2[2];
  if (Math.hypot(dx, dz) < 1e-6) [dx, dz] = [B[0] - A[0], B[2] - A[2]];
  const l = Math.hypot(dx, dz) || 1;
  return [dx / l, 0, dz / l];
}

/** Tightest radius (m) along a curve, from the turn between pieces about a metre long. */
export function tightestRadius(c: CubicBezier): number {
  const n = Math.max(8, Math.ceil(c.length));
  let best = Infinity, px = 0, pz = 0, prevLen = 0;
  let prev = c.point(0);
  for (let i = 1; i <= n; i++) {
    const p = c.point(c.tAtDistance((c.length * i) / n));
    const dx = p[0] - prev[0], dz = p[2] - prev[2], len = Math.hypot(dx, dz);
    if (i > 1 && len > 1e-6 && prevLen > 1e-6) {
      const turn = Math.abs(Math.atan2(px * dz - pz * dx, px * dx + pz * dz));
      if (turn > 1e-5) best = Math.min(best, (len + prevLen) / 2 / turn);
    }
    [px, pz, prevLen, prev] = [dx, dz, len, p];
  }
  return best;
}

/**
 * Speed (km/h, rounded down to 5) that cars slow to on this road's tightest bend, measured on its
 * innermost lane, or null when the bend allows the speed limit.
 */
export function bendSpeed(c: CubicBezier, profile: LaneProfile): number | null {
  const { forward, backward, laneWidth, speedLimit = 50 } = profile;
  const inner = tightestRadius(c) - (Math.max(forward, backward) - 0.5) * laneWidth;
  const v = Math.sqrt(MAX_LAT_ACCEL * Math.max(inner, 1)) * 3.6;
  return v >= speedLimit ? null : Math.max(5, Math.floor(v / 5) * 5);
}

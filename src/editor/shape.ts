import type { Vec3 } from '../core/math';
import type { CubicBezier } from '../network/bezier';
import type { LaneProfile } from '../network/network';
import { MAX_LAT_ACCEL } from '../sim/laneGraph';

/** How the Road tool shapes a new road between its start and end, or 'upgrade': tap roads to change their type. */
export type DrawMode = 'straight' | 'curve' | 'continuous' | 'upgrade';

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
/**
 * Continuous mode matches the previous road's curvature where they join (no sudden change of
 * steering) only by resizing the start handle within this range of the arc's own handle. Further
 * would tighten the curve's middle too much: after a straight road, full matching halves the
 * tightest radius (cars slower), so there the plain arc is kept.
 */
const MATCH_MIN = 0.8, MATCH_MAX = 1.25;

export function continueShape(A: Vec3, B: Vec3, dir: Vec3, k0 = 0): Shape | string {
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
  const c2: Vec3 = [B[0] - ex * k, 0, B[2] - ez * k];
  // Curvature at the start is 2h / (3a²) for start handle length a, where h is how far c2 lies to
  // the side of the start direction: choose a so it equals k0, the previous road's curvature,
  // when that bends the same way and needs only a modest change.
  let a = k;
  const h = dir[0] * (c2[2] - A[2]) - dir[2] * (c2[0] - A[0]);
  if (k0 * h > 1e-9) {
    const want = Math.sqrt((2 * h) / (3 * k0));
    if (want >= MATCH_MIN * k && want <= MATCH_MAX * k) a = want;
  }
  return { c1: [A[0] + dir[0] * a, 0, A[2] + dir[2] * a], c2 };
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

/** Clear space between the two roads of a parallel pair, beyond their sidewalks (m). */
export const MEDIAN = 2;

/**
 * Sideways distance (m) from the drawn line to each road of a parallel pair. One-way roads have
 * their lanes on the right of their own line, and the left road runs the other way, so each sits
 * just past the median with its lanes outwards (a dual carriageway). Two-way roads are centred on
 * their lines, a road's width plus the median apart.
 */
export function parallelOffset(p: LaneProfile): number {
  const { forward: f, backward: b, laneWidth: w, sidewalk: sw } = p;
  if (f === 0 || b === 0) return sw + MEDIAN / 2;
  return ((f + b) * w + 2 * sw + MEDIAN) / 2;
}

/**
 * A cubic Bezier offset `d` metres to the right. The ends move along their normals and keep their
 * directions; both handles are scaled by one factor chosen so the curve's midpoint lands exactly on
 * the true offset of the original midpoint. Exact for straight lines, within centimetres for the
 * arcs roads use.
 */
export function offsetCubic(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, d: number): [Vec3, Vec3, Vec3, Vec3] {
  const unitRight = (dx: number, dz: number): Vec3 | null => {
    const l = Math.hypot(dx, dz);
    return l < 1e-9 ? null : [-dz / l, 0, dx / l];
  };
  const chord = unitRight(p3[0] - p0[0], p3[2] - p0[2]) ?? [0, 0, 1];
  // Tangents at the ends and the middle (B'(t) up to a factor).
  const n0 = unitRight(p1[0] - p0[0], p1[2] - p0[2]) ?? unitRight(p2[0] - p0[0], p2[2] - p0[2]) ?? chord;
  const n3 = unitRight(p3[0] - p2[0], p3[2] - p2[2]) ?? unitRight(p3[0] - p1[0], p3[2] - p1[2]) ?? chord;
  const nm = unitRight(p3[0] + p2[0] - p1[0] - p0[0], p3[2] + p2[2] - p1[2] - p0[2]) ?? chord;
  const q0: Vec3 = [p0[0] + n0[0] * d, 0, p0[2] + n0[2] * d];
  const q3: Vec3 = [p3[0] + n3[0] * d, 0, p3[2] + n3[2] * d];
  const h0: Vec3 = [p1[0] - p0[0], 0, p1[2] - p0[2]], h3: Vec3 = [p2[0] - p3[0], 0, p2[2] - p3[2]];
  // B(1/2) = (q0 + q3)/2 + 3/8 · s · (h0 + h3): pick s so it hits the offset midpoint M.
  const mx = (p0[0] + 3 * p1[0] + 3 * p2[0] + p3[0]) / 8 + nm[0] * d;
  const mz = (p0[2] + 3 * p1[2] + 3 * p2[2] + p3[2]) / 8 + nm[2] * d;
  const sx = h0[0] + h3[0], sz = h0[2] + h3[2], ss = sx * sx + sz * sz;
  const s = ss < 1e-9 ? 1 : ((mx - (q0[0] + q3[0]) / 2) * sx + (mz - (q0[2] + q3[2]) / 2) * sz) / ((3 / 8) * ss);
  return [q0, [q0[0] + h0[0] * s, 0, q0[2] + h0[2] * s], [q3[0] + h3[0] * s, 0, q3[2] + h3[2] * s], q3];
}

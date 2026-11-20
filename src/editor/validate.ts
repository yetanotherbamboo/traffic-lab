import { type Zone, zoneDistance } from '../env/zone';
import type { CubicBezier } from '../network/bezier';
import type { RoadNetwork } from '../network/network';
import { BOUNDARY_TOL, halfWidth, sampleCurve } from './rules';

/** Shortest drivable stretch of road between two junctions (m). */
export const MIN_ROAD = 6;
/** Smallest angle between neighbouring roads at a junction. */
export const MIN_ANGLE = (25 * Math.PI) / 180;
export const MAX_ARMS = 6;

/**
 * Checks the roads an edit created or changed. Returns a message for the player, or null if the
 * network is fine. Only `touched` roads (and their junctions) are checked, so old problems
 * elsewhere never block an edit; `changed` roads must also lie inside the construction zone.
 */
export function validate(net: RoadNetwork, zone: Zone, touched: number[], changed: number[] = touched): string | null {
  const nodes = new Set<number>();
  for (const id of touched) {
    const seg = net.segments.get(id);
    if (!seg) continue;
    nodes.add(seg.a);
    nodes.add(seg.b);
  }

  for (const n of nodes) {
    const arms = net.arms(n);
    if (arms.length > MAX_ARMS) return `At most ${MAX_ARMS} roads can meet at a junction`;
    if (arms.length < 2) continue;
    for (let i = 0; i < arms.length; i++) {
      let gap = arms[(i + 1) % arms.length]!.angle - arms[i]!.angle;
      if (gap <= 0) gap += Math.PI * 2;
      if (gap < MIN_ANGLE) return 'Roads meet at too sharp an angle';
    }
  }

  for (const id of touched) {
    const seg = net.segments.get(id);
    if (!seg) continue;
    const pts = sampleCurve(seg.curve, 2);
    // Roads next to an edit (possibly fixed context roads) only get their junctions checked.
    if (changed.includes(id)) {
      for (const { p } of pts) {
        if (zoneDistance(zone, p[0], p[2]) > BOUNDARY_TOL + 0.5) return 'Roads must stay inside the construction zone';
      }
    }
    const [s0, s1] = net.trimmedRange(seg);
    if (s1 - s0 < MIN_ROAD) return 'Too short: junctions are too close together';

    // Tightest bend: the inner kerb must not fold over.
    const hw = halfWidth(seg);
    for (let k = 1; k + 1 < pts.length; k++) {
      const a = pts[k - 1]!.p, b = pts[k]!.p, c = pts[k + 1]!.p;
      const h1 = Math.atan2(b[2] - a[2], b[0] - a[0]), h2 = Math.atan2(c[2] - b[2], c[0] - b[0]);
      let dh = Math.abs(h2 - h1);
      if (dh > Math.PI) dh = 2 * Math.PI - dh;
      const ds = (pts[k + 1]!.s - pts[k - 1]!.s) / 2;
      if (dh > 1e-4 && ds / dh < hw + 4) return 'Curve is too tight for this road';
    }

    // Overlap with roads it doesn't share a junction with (at shared junctions the angle check applies).
    const mine = sampleCurve(seg.curve, 2, s0 + 0.5, Math.max(s0 + 0.5, s1 - 0.5));
    for (const other of net.segments.values()) {
      if (other.id === id || other.a === seg.a || other.a === seg.b || other.b === seg.a || other.b === seg.b) continue;
      if (!boxesNear(seg.curve, other.curve, hw + halfWidth(other))) continue;
      const [o0, o1] = net.trimmedRange(other);
      if (o1 - o0 < 0.5) continue;
      const theirs = sampleCurve(other.curve, 2, o0, o1);
      const need = hw + halfWidth(other) - 0.5;
      for (const { p } of mine) {
        for (let k = 0; k + 1 < theirs.length; k++) {
          const a = theirs[k]!.p, b = theirs[k + 1]!.p;
          const dx = b[0] - a[0], dz = b[2] - a[2];
          const l2 = dx * dx + dz * dz;
          const u = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[2] - a[2]) * dz) / l2)) : 0;
          if (Math.hypot(p[0] - a[0] - dx * u, p[2] - a[2] - dz * u) < need) return 'Overlaps another road';
        }
      }
    }
  }
  return null;
}

/** Do the control-point hulls of two curves come within `pad` of each other (cheap pre-check)? */
function boxesNear(a: CubicBezier, b: CubicBezier, pad: number): boolean {
  const box = (c: CubicBezier): [number, number, number, number] => {
    const xs = [c.p0[0], c.p1[0], c.p2[0], c.p3[0]], zs = [c.p0[2], c.p1[2], c.p2[2], c.p3[2]];
    return [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
  };
  const A = box(a), B = box(b);
  return A[0] - pad <= B[1] && B[0] - pad <= A[1] && A[2] - pad <= B[3] && B[2] - pad <= A[3];
}

import type { Vec3 } from '../core/math';
import { type Zone, zoneDistance } from '../env/zone';
import type { CubicBezier } from '../network/bezier';
import type { RoadNetwork, RoadSegment } from '../network/network';

/** Nodes within this distance of the construction-zone border count as boundary nodes. */
export const BOUNDARY_TOL = 1;

/** Half the full width of a road including sidewalks (largest side), metres. */
export function halfWidth(seg: RoadSegment): number {
  const { forward, backward, laneWidth, sidewalk } = seg.profile;
  return Math.max(forward, backward) * laneWidth + sidewalk;
}

/** Points along a curve roughly every `step` metres, with their curve parameter. */
export function sampleCurve(curve: CubicBezier, step: number, s0 = 0, s1 = curve.length): { p: Vec3; t: number; s: number }[] {
  const n = Math.max(1, Math.ceil((s1 - s0) / step));
  const out: { p: Vec3; t: number; s: number }[] = [];
  for (let k = 0; k <= n; k++) {
    const s = s0 + ((s1 - s0) * k) / n;
    const t = curve.tAtDistance(s);
    out.push({ p: curve.point(t), t, s });
  }
  return out;
}

/** The player may build on and connect to this node (inside the zone or on its border). */
export function nodeConnectable(net: RoadNetwork, zone: Zone, id: number): boolean {
  const p = net.node(id).pos;
  return zoneDistance(zone, p[0], p[2]) <= BOUNDARY_TOL;
}

/** The player may change or remove this road: it lies inside the construction zone. */
export function segmentEditable(net: RoadNetwork, zone: Zone, seg: RoadSegment): boolean {
  if (!nodeConnectable(net, zone, seg.a) || !nodeConnectable(net, zone, seg.b)) return false;
  const m = seg.curve.point(0.5);
  return zoneDistance(zone, m[0], m[2]) < 0;
}

/**
 * Splits every road that crosses the construction-zone border at the border, so roads inside
 * are editable and roads outside stay fixed context. Splits use same-profile straight
 * continuations, which render seamlessly.
 */
export function splitAtZone(net: RoadNetwork, zone: Zone): void {
  const queue = [...net.segments.keys()];
  while (queue.length > 0) {
    const id = queue.pop()!;
    const seg = net.segments.get(id);
    if (!seg) continue;
    const pts = sampleCurve(seg.curve, 1);
    const zd = pts.map(({ p }) => zoneDistance(zone, p[0], p[2]));
    let cut = -1;
    for (let k = 0; k + 1 < pts.length; k++) {
      if (Math.sign(zd[k]!) === Math.sign(zd[k + 1]!) || zd[k] === 0) continue;
      // Skip crossings right at an end node: that node already is the boundary.
      if (pts[k + 1]!.s < 2 || pts[k]!.s > seg.curve.length - 2) continue;
      let lo = pts[k]!.t, hi = pts[k + 1]!.t;
      const sLo = Math.sign(zd[k]!);
      for (let it = 0; it < 30; it++) {
        const mid = (lo + hi) / 2, p = seg.curve.point(mid);
        if (Math.sign(zoneDistance(zone, p[0], p[2])) === sLo) lo = mid;
        else hi = mid;
      }
      cut = (lo + hi) / 2;
      break;
    }
    if (cut < 0) continue;
    const { first, second } = net.splitSegment(id, cut);
    queue.push(first, second);
  }
}

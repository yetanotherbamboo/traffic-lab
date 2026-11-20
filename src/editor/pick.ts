import type { Vec3 } from '../core/math';
import type { RoadNetwork } from '../network/network';
import { halfWidth, sampleCurve } from './rules';

export type Pick =
  | { kind: 'node'; id: number; pos: Vec3 }
  | { kind: 'segment'; id: number; t: number; pos: Vec3; dist: number }
  | null;

/** Closest point on a road's centreline to (x, z): curve parameter, point and distance. */
export function nearestOnSegment(net: RoadNetwork, segId: number, x: number, z: number): { t: number; pos: Vec3; dist: number } {
  const curve = net.segment(segId).curve;
  const pts = sampleCurve(curve, 1);
  let best = { t: 0, pos: pts[0]!.p, dist: Infinity };
  for (let k = 0; k + 1 < pts.length; k++) {
    const a = pts[k]!, b = pts[k + 1]!;
    const dx = b.p[0] - a.p[0], dz = b.p[2] - a.p[2];
    const l2 = dx * dx + dz * dz;
    const u = l2 > 0 ? Math.max(0, Math.min(1, ((x - a.p[0]) * dx + (z - a.p[2]) * dz) / l2)) : 0;
    const px = a.p[0] + dx * u, pz = a.p[2] + dz * u;
    const d = Math.hypot(x - px, z - pz);
    if (d < best.dist) {
      const t = a.t + (b.t - a.t) * u;
      best = { t, pos: curve.point(t), dist: d };
    }
  }
  return best;
}

/**
 * What lies under a ground point: a junction or road end (within `tol` metres, or inside the
 * junction surface), else a road (within its width plus `tol`). Filters restrict the candidates.
 */
export function pickAt(
  net: RoadNetwork, p: Vec3, tol: number,
  filter: { node?: (id: number) => boolean; segment?: (id: number) => boolean } = {},
): Pick {
  let bestNode: Pick = null, bestNodeD = Infinity;
  for (const n of net.nodes.values()) {
    if (filter.node && !filter.node(n.id)) continue;
    const d = Math.hypot(n.pos[0] - p[0], n.pos[2] - p[2]);
    const r = Math.max(tol, net.junctionRadius(n.id) * 0.8);
    if (d < r && d < bestNodeD) [bestNode, bestNodeD] = [{ kind: 'node', id: n.id, pos: n.pos }, d];
  }
  if (bestNode) return bestNode;

  let best: Pick = null, bestD = Infinity;
  for (const seg of net.segments.values()) {
    if (filter.segment && !filter.segment(seg.id)) continue;
    const near = nearestOnSegment(net, seg.id, p[0], p[2]);
    const reach = halfWidth(seg) + tol * 0.5;
    if (near.dist < reach && near.dist < bestD) {
      bestD = near.dist;
      best = { kind: 'segment', id: seg.id, t: near.t, pos: near.pos, dist: near.dist };
    }
  }
  return best;
}

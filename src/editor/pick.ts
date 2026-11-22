import type { Vec3 } from '../core/math';
import { type RoadNetwork, SAME_LEVEL } from '../network/network';
import { halfWidth, sampleCurve } from './rules';

export type Pick =
  | { kind: 'node'; id: number; pos: Vec3 }
  | { kind: 'segment'; id: number; t: number; pos: Vec3; dist: number }
  | { kind: 'roundabout'; id: number; pos: Vec3 }
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
 * The point at height `y` on the line of sight through ground point `p` (y = 0), looking along
 * `look` (towards the ground). Straight down (the default) it is `p` itself.
 */
export function lift(p: Vec3, y: number, look?: Vec3): Vec3 {
  if (!look || look[1] > -1e-3 || y === 0) return [p[0], y, p[2]];
  const s = y / look[1];
  return [p[0] + look[0] * s, y, p[2] + look[2] * s];
}

export interface PickOptions {
  node?: (id: number) => boolean;
  segment?: (id: number) => boolean;
  /** Direction the camera looks through the point, so raised roads are picked where they are seen. */
  look?: Vec3;
  /**
   * Height (m) to prefer where roads on several levels are under the finger (the level being
   * built on). Without it the topmost wins, as it hides the others.
   */
  prefer?: number;
}

/** Ranks a candidate at height `y`: lower is better (then the nearer one wins). */
function rank(y: number, prefer: number | undefined): number {
  return prefer !== undefined ? (Math.abs(y - prefer) <= SAME_LEVEL ? 0 : 1) : -Math.round(y);
}

/**
 * What lies under a ground point: a junction or road end (within `tol` metres, or inside the
 * junction surface), else a road (within its width plus `tol`). Filters restrict the candidates.
 * Each candidate is measured where the line of sight passes its height (see `PickOptions.look`).
 */
export function pickAt(net: RoadNetwork, p: Vec3, tol: number, opt: PickOptions = {}): Pick {
  const { look, prefer } = opt;
  let bestNode: Pick = null, bestNodeD = Infinity, bestNodeR = Infinity;
  for (const n of net.nodes.values()) {
    if (opt.node && !opt.node(n.id)) continue;
    const q = lift(p, n.pos[1], look);
    const d = Math.hypot(n.pos[0] - q[0], n.pos[2] - q[2]);
    const r = Math.max(tol, net.junctionRadius(n.id) * 0.8);
    const k = rank(n.pos[1], prefer);
    if (d < r && (k < bestNodeR || (k === bestNodeR && d < bestNodeD))) [bestNode, bestNodeD, bestNodeR] = [{ kind: 'node', id: n.id, pos: n.pos }, d, k];
  }
  if (bestNode) return bestNode;

  let best: Pick = null, bestD = Infinity, bestR = Infinity;
  for (const seg of net.segments.values()) {
    if (opt.segment && !opt.segment(seg.id)) continue;
    // Raised roads: measure in the plane of the road's height near the point (refined once on ramps).
    let near = nearestOnSegment(net, seg.id, ...xz(lift(p, seg.curve.point(0.5)[1], look)));
    if (look && Math.abs(near.pos[1] - seg.curve.point(0.5)[1]) > 0.1) near = nearestOnSegment(net, seg.id, ...xz(lift(p, near.pos[1], look)));
    const reach = halfWidth(seg) + tol * 0.5;
    const k = rank(near.pos[1], prefer);
    if (near.dist < reach && (k < bestR || (k === bestR && near.dist < bestD))) {
      [bestD, bestR] = [near.dist, k];
      best = { kind: 'segment', id: seg.id, t: near.t, pos: near.pos, dist: near.dist };
    }
  }
  return best;
}

const xz = (q: Vec3): [number, number] => [q[0], q[2]];

import type { Vec3 } from '../core/math';
import type { Zone } from '../env/zone';
import { type RoadNetwork, horizontal } from '../network/network';
import { lift, pickAt } from './pick';
import { nodeConnectable, segmentEditable } from './rules';

/** Where a new road starts or ends. */
export type Anchor =
  | { kind: 'node'; id: number; pos: Vec3 }
  | { kind: 'segment'; id: number; t: number; pos: Vec3 }
  | { kind: 'free'; pos: Vec3 };

export interface Snap {
  anchor: Anchor;
  /** True when a free end was rotated onto a preferred angle. */
  aligned: boolean;
  /** Guide lines the point snapped onto, each from where it starts to the snapped point. */
  guides: [Vec3, Vec3][];
}

/** A guide line: from `o` in unit direction `d` (a ray, t ≥ 0). */
interface Ray {
  o: Vec3;
  d: Vec3;
}

/** Guides come from road ends within this distance of the point (m). */
const GUIDE_RANGE = 90;

const ANGLE_STEP = Math.PI / 12; // 15°
const ANGLE_SNAP = (5 * Math.PI) / 180;
/** Roads joining an existing road closer than this to its junction edge snap to the junction. */
const END_SNAP = 3;

/**
 * Guide lines near `p`, as in Cities: Skylines: at every node, the extension of each road past
 * the node (where no road continues it) and the perpendiculars to each road. Roundabout rings
 * give none. Lines through `skip` (the road's own start, already covered by angle snapping) are
 * left out.
 */
function guideRays(net: RoadNetwork, p: Vec3, skip?: Vec3): Ray[] {
  const rays: Ray[] = [];
  for (const node of net.nodes.values()) {
    if (node.ring !== undefined || node.segments.length === 0) continue;
    if (Math.hypot(node.pos[0] - p[0], node.pos[2] - p[2]) > GUIDE_RANGE) continue;
    if (skip && Math.hypot(node.pos[0] - skip[0], node.pos[2] - skip[2]) < 0.5) continue;
    // Each road's direction leaving the node, straight from its curve (cheap: this runs on every pointer move).
    const dirs: Vec3[] = [];
    for (const sid of node.segments) {
      const seg = net.segment(sid);
      if (seg.ring !== undefined) continue;
      const d = horizontal(seg.curve.derivative(seg.a === node.id ? 0 : 1));
      dirs.push(seg.a === node.id ? d : [-d[0], 0, -d[2]]);
    }
    const taken = (d: Vec3): boolean => dirs.some((e) => e[0] * d[0] + e[2] * d[2] > 0.97);
    const add = (d: Vec3): void => {
      if (taken(d) || rays.some((r) => r.o === node.pos && r.d[0] * d[0] + r.d[2] * d[2] > 0.999)) return;
      rays.push({ o: node.pos, d });
    };
    for (const a of dirs) {
      add([-a[0], 0, -a[2]]); // straight on past the node
      add([-a[2], 0, a[0]]); // perpendiculars
      add([a[2], 0, -a[0]]);
    }
  }
  return rays;
}

/** Point on ray `r` closest to `p`, and its distance (Infinity behind the ray's start). */
function onRay(r: Ray, p: Vec3): { q: Vec3; dist: number } {
  const t = (p[0] - r.o[0]) * r.d[0] + (p[2] - r.o[2]) * r.d[2];
  if (t < 1) return { q: p, dist: Infinity };
  const q: Vec3 = [r.o[0] + r.d[0] * t, p[1], r.o[2] + r.d[2] * t];
  return { q, dist: Math.hypot(q[0] - p[0], q[2] - p[2]) };
}

/** Where two lines cross (each through `o` along `d`), or null if nearly parallel. */
function cross(ao: Vec3, ad: Vec3, bo: Vec3, bd: Vec3, y = 0): Vec3 | null {
  const den = ad[0] * bd[2] - ad[2] * bd[0];
  if (Math.abs(den) < 0.17) return null; // under ~10°
  const t = ((bo[0] - ao[0]) * bd[2] - (bo[2] - ao[2]) * bd[0]) / den;
  return [ao[0] + ad[0] * t, y, ao[2] + ad[2] * t];
}

/**
 * Snaps a free point onto guide lines within `tol`: where two guides cross, where the angle-snapped
 * direction from the start (`o`, `dir`) crosses a guide, or else onto the nearest guide.
 */
function snapToGuides(net: RoadNetwork, p: Vec3, tol: number, o?: Vec3, dir?: Vec3): { pos: Vec3; guides: [Vec3, Vec3][] } | null {
  const near = guideRays(net, p, o)
    .map((r) => ({ r, ...onRay(r, p) }))
    .filter((g) => g.dist < tol)
    .sort((a, b) => a.dist - b.dist);
  const g1 = near[0];
  if (!g1) return null;
  for (const g2 of near.slice(1)) {
    const x = cross(g1.r.o, g1.r.d, g2.r.o, g2.r.d, p[1]);
    if (x && Math.hypot(x[0] - p[0], x[2] - p[2]) < tol && onRay(g1.r, x).dist < 0.01 && onRay(g2.r, x).dist < 0.01) {
      return { pos: x, guides: [[g1.r.o, x], [g2.r.o, x]] };
    }
  }
  if (o && dir) {
    const x = cross(o, dir, g1.r.o, g1.r.d, p[1]);
    if (x && Math.hypot(x[0] - p[0], x[2] - p[2]) < tol && onRay(g1.r, x).dist < 0.01) return { pos: x, guides: [[g1.r.o, x]] };
  }
  return { pos: g1.q, guides: [[g1.r.o, g1.q]] };
}

/** Directions (angles) of the roads at a node, measured away from it. */
function armAngles(net: RoadNetwork, nodeId: number): number[] {
  return net.arms(nodeId).map((a) => a.angle);
}

/** Where the finger is: the ground point under it, how the camera looks through it, and the level. */
export interface Aim {
  /** Direction of the line of sight (towards the ground); straight down if omitted. */
  look?: Vec3;
  /** Height (m) of the level being built on: free points are placed there. */
  y?: number;
}

/**
 * Snaps a ground point for road drawing: to a connectable node, else onto an editable road (a new
 * junction there), else a free point. A free end is aligned to 15° steps relative to the world
 * axes and to the roads at the start, and its length is rounded to whole metres. Nodes and roads
 * on the level being built on (`aim.y`) win over others under the finger; free points are placed
 * at that level, where the line of sight meets it.
 */
export function snapPoint(net: RoadNetwork, zone: Zone, p: Vec3, tol: number, from?: Anchor, snapping = true, aim: Aim = {}): Snap {
  const y = aim.y ?? 0;
  const pick = pickAt(net, p, tol, {
    node: (id) => nodeConnectable(net, zone, id),
    segment: (id) => segmentEditable(net, zone, net.segment(id)),
    look: aim.look,
    prefer: y,
  });
  if (pick?.kind === 'node') return { anchor: { kind: 'node', id: pick.id, pos: pick.pos }, aligned: false, guides: [] };
  if (pick?.kind === 'segment') {
    const seg = net.segment(pick.id);
    const s = seg.curve.length * pick.t; // close enough for an end-distance check
    const nearA = s < END_SNAP + net.armTrim(seg.a, seg.id), nearB = seg.curve.length - s < END_SNAP + net.armTrim(seg.b, seg.id);
    if (nearA || nearB) {
      const id = nearA && (!nearB || s < seg.curve.length / 2) ? seg.a : seg.b;
      if (nodeConnectable(net, zone, id)) return { anchor: { kind: 'node', id, pos: net.node(id).pos }, aligned: false, guides: [] };
    }
    return { anchor: { kind: 'segment', id: pick.id, t: pick.t, pos: pick.pos }, aligned: false, guides: [] };
  }

  const pos = lift(p, y, aim.look);
  const free = (q: Vec3, aligned = false, guides: [Vec3, Vec3][] = []): Snap => ({ anchor: { kind: 'free', pos: q }, aligned, guides });
  if (!snapping) return free(pos);
  if (!from) {
    const g = snapToGuides(net, pos, tol);
    return g ? free(g.pos, false, g.guides) : free([Math.round(pos[0]), y, Math.round(pos[2])]);
  }

  const o = from.pos;
  const dx = pos[0] - o[0], dz = pos[2] - o[2];
  const len = Math.hypot(dx, dz);
  if (len < 1) return free(pos);
  const ang = Math.atan2(dz, dx);
  const bases = [0];
  if (from.kind === 'node') bases.push(...armAngles(net, from.id));
  if (from.kind === 'segment') {
    const d = net.segment(from.id).curve.derivative(from.t);
    bases.push(Math.atan2(d[2], d[0]));
  }
  let best = ang, bestDiff = ANGLE_SNAP;
  for (const b of bases) {
    const k = Math.round((ang - b) / ANGLE_STEP);
    const cand = b + k * ANGLE_STEP;
    const diff = Math.abs(cand - ang);
    if (diff < bestDiff) [best, bestDiff] = [cand, diff];
  }
  const aligned = best !== ang;
  const g = snapToGuides(net, pos, tol, o, aligned ? [Math.cos(best), 0, Math.sin(best)] : undefined);
  if (g) return free(g.pos, aligned, g.guides);
  const L = Math.round(len);
  return free([o[0] + Math.cos(best) * L, y, o[2] + Math.sin(best) * L], aligned);
}

/**
 * Snaps a point that isn't joining anything (a junction being moved): onto guide lines from other
 * nodes (not from `skip`, its own position), else to whole metres. `snapping` off: as it is.
 * The point keeps `skip`'s height, found where the line of sight (`look`) meets it.
 */
export function snapFree(net: RoadNetwork, p: Vec3, tol: number, skip: Vec3, snapping = true, look?: Vec3): { pos: Vec3; guides: [Vec3, Vec3][] } {
  const pos = lift(p, skip[1], look);
  if (!snapping) return { pos, guides: [] };
  return snapToGuides(net, pos, tol, skip) ?? { pos: [Math.round(pos[0]), pos[1], Math.round(pos[2])], guides: [] };
}

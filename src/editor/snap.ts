import type { Vec3 } from '../core/math';
import type { Zone } from '../env/zone';
import type { RoadNetwork } from '../network/network';
import { pickAt } from './pick';
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
}

const ANGLE_STEP = Math.PI / 12; // 15°
const ANGLE_SNAP = (5 * Math.PI) / 180;
/** Roads joining an existing road closer than this to its junction edge snap to the junction. */
const END_SNAP = 3;

/** Directions (angles) of the roads at a node, measured away from it. */
function armAngles(net: RoadNetwork, nodeId: number): number[] {
  return net.arms(nodeId).map((a) => a.angle);
}

/**
 * Snaps a ground point for road drawing: to a connectable node, else onto an editable road (a new
 * junction there), else a free point. A free end is aligned to 15° steps relative to the world
 * axes and to the roads at the start, and its length is rounded to whole metres.
 */
export function snapPoint(net: RoadNetwork, zone: Zone, p: Vec3, tol: number, from?: Anchor): Snap {
  const pick = pickAt(net, p, tol, {
    node: (id) => nodeConnectable(net, zone, id),
    segment: (id) => segmentEditable(net, zone, net.segment(id)),
  });
  if (pick?.kind === 'node') return { anchor: { kind: 'node', id: pick.id, pos: pick.pos }, aligned: false };
  if (pick?.kind === 'segment') {
    const seg = net.segment(pick.id);
    const s = seg.curve.length * pick.t; // close enough for an end-distance check
    const nearA = s < END_SNAP + net.armTrim(seg.a, seg.id), nearB = seg.curve.length - s < END_SNAP + net.armTrim(seg.b, seg.id);
    if (nearA || nearB) {
      const id = nearA && (!nearB || s < seg.curve.length / 2) ? seg.a : seg.b;
      if (nodeConnectable(net, zone, id)) return { anchor: { kind: 'node', id, pos: net.node(id).pos }, aligned: false };
    }
    return { anchor: { kind: 'segment', id: pick.id, t: pick.t, pos: pick.pos }, aligned: false };
  }

  const pos: Vec3 = [p[0], 0, p[2]];
  if (!from) return { anchor: { kind: 'free', pos: [Math.round(pos[0]), 0, Math.round(pos[2])] }, aligned: false };

  const o = from.pos;
  const dx = pos[0] - o[0], dz = pos[2] - o[2];
  const len = Math.hypot(dx, dz);
  if (len < 1) return { anchor: { kind: 'free', pos }, aligned: false };
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
  const L = Math.round(len);
  return {
    anchor: { kind: 'free', pos: [o[0] + Math.cos(best) * L, 0, o[2] + Math.sin(best) * L] },
    aligned: best !== ang,
  };
}

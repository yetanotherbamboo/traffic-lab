import { type Vec3, vec3 } from '../core/math';
import { type JunctionControl, type LaneProfile, MAX_GRADE, type RoadNetwork, SAME_LEVEL, horizontal, rightOf } from '../network/network';
import { roadCost } from './cost';
import { nearestOnSegment } from './pick';
import { sampleCurve } from './rules';
import type { Shape } from './shape';
import type { Anchor } from './snap';
import { MAX_ARMS, MIN_ANGLE, tooShort } from './validate';

/**
 * Editing operations on a road network. Each mutates the network it is given (the editor runs
 * them on a copy, validates the result and only then makes it the live network) and returns the
 * ids of the roads it created or changed (for validation and highlighting) and its cost in k€.
 */

export interface EditResult {
  /** Roads the edit built or reshaped (checked against the zone). */
  changed: number[];
  /** `changed` plus the roads around them whose junctions changed. */
  touched: number[];
  cost: number;
}

export const MAX_LANES = 4;

/** Turns an anchor into a node, splitting a road or creating a node as needed. */
function resolve(net: RoadNetwork, a: Anchor): number {
  if (a.kind === 'node') return a.id;
  if (a.kind === 'free') return net.addNode(a.pos);
  let id = a.id, t = a.t;
  if (!net.segments.has(id)) {
    // The road was already split by the other anchor: find the piece under the point.
    let bestD = Infinity;
    for (const seg of net.segments.values()) {
      const n = nearestOnSegment(net, seg.id, a.pos[0], a.pos[2]);
      if (n.dist < bestD) [bestD, id, t] = [n.dist, seg.id, n.t];
    }
  }
  return net.splitSegment(id, t).node;
}

/** Intersection of 2D segments p→q and r→s; returns [u along pq, v along rs] or null. */
function cross2(p: Vec3, q: Vec3, r: Vec3, s: Vec3): [number, number] | null {
  const ax = q[0] - p[0], az = q[2] - p[2], bx = s[0] - r[0], bz = s[2] - r[2];
  const den = ax * bz - az * bx;
  if (Math.abs(den) < 1e-9) return null;
  const cx = r[0] - p[0], cz = r[2] - p[2];
  const u = (cx * bz - cz * bx) / den, v = (cx * az - cz * ax) / den;
  return u >= 0 && u <= 1 && v >= 0 && v <= 1 ? [u, v] : null;
}

/**
 * Where road `aId` crosses another road that it doesn't share a node with: the curve
 * parameters on both, closest to the start of `aId`. Ends within 1 m are ignored.
 */
function firstCrossing(net: RoadNetwork, aId: number, skip: Set<number>): { other: number; ta: number; tb: number } | null {
  const A = net.segment(aId);
  const pa = sampleCurve(A.curve, 1.5);
  let best: { other: number; ta: number; tb: number; s: number } | null = null;
  for (const B of net.segments.values()) {
    if (B.id === aId || skip.has(B.id)) continue;
    if (B.a === A.a || B.a === A.b || B.b === A.a || B.b === A.b) continue;
    const pb = sampleCurve(B.curve, 1.5);
    for (let i = 0; i + 1 < pa.length; i++) {
      for (let j = 0; j + 1 < pb.length; j++) {
        const hit = cross2(pa[i]!.p, pa[i + 1]!.p, pb[j]!.p, pb[j + 1]!.p);
        if (!hit) continue;
        // Different levels pass over each other (validation checks there's room between them).
        const ya = pa[i]!.p[1] + (pa[i + 1]!.p[1] - pa[i]!.p[1]) * hit[0];
        const yb = pb[j]!.p[1] + (pb[j + 1]!.p[1] - pb[j]!.p[1]) * hit[1];
        if (Math.abs(ya - yb) > SAME_LEVEL) continue;
        const s = pa[i]!.s + (pa[i + 1]!.s - pa[i]!.s) * hit[0];
        if (s < 1 || s > A.curve.length - 1 || (best && s >= best.s)) continue;
        best = {
          other: B.id, s,
          ta: pa[i]!.t + (pa[i + 1]!.t - pa[i]!.t) * hit[0],
          tb: pb[j]!.t + (pb[j + 1]!.t - pb[j]!.t) * hit[1],
        };
      }
    }
  }
  return best;
}

/**
 * Inserts junctions wherever the given roads cross other roads. Returns the ids of the pieces the
 * given roads were cut into (the crossed roads share the new junctions, so `touchedAround` finds them).
 */
function splitCrossings(net: RoadNetwork, ids: number[]): number[] {
  const pending = [...ids];
  const done: number[] = [];
  for (let guard = 0; pending.length > 0 && guard < 64; guard++) {
    const id = pending.pop()!;
    if (!net.segments.has(id)) continue;
    const hit = firstCrossing(net, id, new Set(pending));
    if (!hit) {
      done.push(id);
      continue;
    }
    const x = net.splitSegment(hit.other, hit.tb);
    const y = net.splitSegment(id, hit.ta, x.node);
    pending.push(y.first, y.second);
  }
  return [...done, ...pending];
}

/** Shown when a new road can't start (or end) at a point; see `anchorProblem`. */
export const TOO_CLOSE = 'Too close to a junction: start the road further away from it';

/** Shown when a junction has no gap wide enough for another road. */
export const NO_ROOM = 'No room for another road at this junction';

/** Length of the trial road used by `anchorProblem` (m). */
const STUB = 30;

/**
 * Can a new road of `profile` attach at this anchor at all, whatever direction it is drawn in?
 * Trial roads are added in every direction that could work: both sides of a road (perpendicular,
 * the angle that needs the least room), or the middle of each gap between a junction's roads.
 * If every trial leaves a road piece too short (`tooShort`), no road can start here. Returns the
 * reason, or null.
 */
export function anchorProblem(net: RoadNetwork, a: Anchor, profile: LaneProfile): string | null {
  if (a.kind === 'node') {
    if (!net.nodes.has(a.id)) return null;
    const node = net.node(a.id);
    if (node.segments.length >= MAX_ARMS) return `At most ${MAX_ARMS} roads can meet at a junction`;
    // Roundabout rings are rebuilt evenly around a new entry, so a trial says nothing there.
    if (node.ring !== undefined) return null;
    const arms = net.arms(a.id);
    if (arms.length === 0) return null;
    const dirs: number[] = [];
    if (arms.length === 1) {
      const h = arms[0]!.angle;
      dirs.push(h + Math.PI, h + Math.PI / 2, h - Math.PI / 2);
    } else {
      for (let i = 0; i < arms.length; i++) {
        let gap = arms[(i + 1) % arms.length]!.angle - arms[i]!.angle;
        if (gap <= 0) gap += Math.PI * 2;
        if (gap >= 2 * MIN_ANGLE) dirs.push(arms[i]!.angle + gap / 2);
      }
      if (dirs.length === 0) return NO_ROOM;
    }
    for (const h of dirs) {
      const trial = net.clone();
      const p = trial.node(a.id).pos;
      const stub = trial.addSegment(a.id, trial.addNode([p[0] + Math.cos(h) * STUB, 0, p[2] + Math.sin(h) * STUB]), profile);
      // Only the existing roads count: the new one can be drawn as long as it needs to be.
      const fits = (): boolean => !trial.node(a.id).segments.some((id) => id !== stub && tooShort(trial, trial.segment(id)));
      if (fits()) return null;
      if (trial.entranceLayout(a.id)) {
        trial.node(a.id).entrance = true;
        if (fits()) return null;
      }
    }
    return TOO_CLOSE;
  }
  if (a.kind !== 'segment' || !net.segments.has(a.id)) return null;
  if (net.segment(a.id).ring !== undefined) return null;
  for (const side of [1, -1]) {
    const trial = net.clone();
    const r = rightOf(horizontal(trial.segment(a.id).curve.derivative(a.t)));
    const { node, first, second } = trial.splitSegment(a.id, a.t);
    const p = trial.node(node).pos;
    trial.addSegment(node, trial.addNode([p[0] + r[0] * STUB * side, 0, p[2] + r[2] * STUB * side]), profile);
    const fits = (): boolean => !tooShort(trial, trial.segment(first)) && !tooShort(trial, trial.segment(second));
    if (fits()) return null;
    if (trial.entranceLayout(node)) {
      trial.node(node).entrance = true; // a small road may join as an entrance
      if (fits()) return null;
    }
  }
  return TOO_CLOSE;
}

/** Ramps are this much longer than the steepest grade allows, so they always pass the grade check. */
const RAMP_SLACK = 1.03;

/** Length of road (m) a ramp needs to climb `dy` metres. */
export const rampLength = (dy: number): number => (Math.abs(dy) / MAX_GRADE) * RAMP_SLACK;

/**
 * Builds a road between two anchors, adding junctions where it crosses other roads. With a
 * `level` (height in m), the road runs at that height and gets a ramp at each end that joins a
 * road or junction on another level: the first (or last) `rampLength` metres climb steadily and
 * a plain joint marks where the ramp meets the level part. Free ends are at the anchors' heights.
 */
export function addRoad(net: RoadNetwork, start: Anchor, end: Anchor, profile: LaneProfile, shape?: Shape, level?: number): EditResult {
  const a = resolve(net, start);
  const b = resolve(net, end);
  if (a === b) throw new EditError('Road is too short');
  if (net.node(a).segments.some((s) => net.otherEnd(net.segment(s), a) === b)) throw new EditError('These points are already connected');
  const id = net.addSegment(a, b, profile, shape?.c1, shape?.c2);
  const cost = roadCost(net.segment(id));
  const pieces = level === undefined ? [id] : addRamps(net, id, level);
  const changed = splitCrossings(net, pieces);
  preferEntrance(net, a);
  preferEntrance(net, b);
  return { changed, touched: touchedAround(net, changed), cost };
}

/**
 * Splits road `id` so it runs at height `level` between ramps at the ends that are on another
 * level (see `addRoad`). Returns the pieces, in order from its start.
 */
function addRamps(net: RoadNetwork, id: number, level: number): number[] {
  const seg = net.segment(id);
  const ya = net.node(seg.a).pos[1], yb = net.node(seg.b).pos[1];
  const ra = Math.abs(ya - level) > SAME_LEVEL ? rampLength(ya - level) : 0;
  const rb = Math.abs(yb - level) > SAME_LEVEL ? rampLength(yb - level) : 0;
  if (ra === 0 && rb === 0) return [id];
  const len = seg.curve.length;
  if (ra + rb > len + 0.5) {
    throw new EditError(`Too short for this level: the ${ra > 0 && rb > 0 ? 'ramps need' : 'ramp needs'} ${Math.ceil(ra + rb)} m of road (this one is ${Math.floor(len)} m)`);
  }
  // A ramp reaching (nearly) the other end needs no level part: the road's steady slope is the ramp.
  const pieces: number[] = [];
  let rest = id;
  const lift = (node: number): void => {
    net.node(node).pos[1] = level;
    for (const s of net.node(node).segments) net.setCurve(s, net.segment(s).curve.p1, net.segment(s).curve.p2);
  };
  if (ra > 0 && len - ra > 2) {
    const cut = net.splitSegment(rest, seg.curve.tAtDistance(ra));
    lift(cut.node);
    pieces.push(cut.first);
    rest = cut.second;
  }
  const r = net.segment(rest);
  if (rb > 0 && r.curve.length - rb > 2) {
    const cut = net.splitSegment(rest, r.curve.tAtDistance(r.curve.length - rb));
    lift(cut.node);
    pieces.push(cut.first, cut.second);
  } else {
    pieces.push(rest);
  }
  return pieces;
}

/** Does a road at this node leave any of its roads too short? */
function crowded(net: RoadNetwork, nodeId: number): boolean {
  return net.node(nodeId).segments.some((id) => tooShort(net, net.segment(id)));
}

/**
 * Where a small road joins a through road and a full junction doesn't fit, the join becomes an
 * entrance (a driveway-like join that needs much less room), if that fits.
 */
export function preferEntrance(net: RoadNetwork, nodeId: number): void {
  if (!net.nodes.has(nodeId)) return;
  const node = net.node(nodeId);
  if (node.entrance || !net.entranceLayout(nodeId) || !crowded(net, nodeId)) return;
  node.entrance = true;
  if (crowded(net, nodeId)) delete node.entrance;
}

/**
 * Bends a road so its middle passes through `handle` (a quadratic-style arc between its fixed
 * ends). Near the straight line the road snaps back to straight.
 */
export function bendRoad(net: RoadNetwork, segId: number, handle: Vec3): EditResult {
  const seg = net.segment(segId);
  const A = net.node(seg.a).pos, B = net.node(seg.b).pos;
  const mid = vec3.scale(vec3.add(A, B), 0.5);
  const chord = Math.hypot(B[0] - A[0], B[2] - A[2]);
  const off = Math.hypot(handle[0] - mid[0], handle[2] - mid[2]);
  if (off < Math.max(1, chord * 0.03)) {
    net.setCurve(segId, vec3.add(A, vec3.scale(vec3.sub(B, A), 1 / 3)), vec3.add(A, vec3.scale(vec3.sub(B, A), 2 / 3)));
  } else {
    const H: Vec3 = [handle[0], 0, handle[2]];
    const Q = vec3.sub(vec3.scale(H, 2), mid); // quadratic control point whose curve passes through H
    net.setCurve(segId, vec3.add(A, vec3.scale(vec3.sub(Q, A), 2 / 3)), vec3.add(B, vec3.scale(vec3.sub(Q, B), 2 / 3)));
  }
  const cost = roadCost(seg);
  const changed = splitCrossings(net, [segId]);
  return { changed, touched: touchedAround(net, changed), cost };
}

export function deleteRoad(net: RoadNetwork, segId: number): EditResult {
  const seg = net.segment(segId);
  const ends = [seg.a, seg.b];
  net.removeSegment(segId);
  return { changed: [], touched: touchedAround(net, [], ends), cost: 0 };
}

/** Changes the number of lanes in each direction (clears that road's lane-use overrides). */
export function setLanes(net: RoadNetwork, segId: number, forward: number, backward: number): EditResult {
  const seg = net.segment(segId);
  if (forward < 0 || backward < 0 || forward + backward < 1 || forward > MAX_LANES || backward > MAX_LANES) {
    throw new EditError('Not a valid number of lanes');
  }
  const before = roadCost(seg);
  const around = [...new Set([seg.a, seg.b].flatMap((n) => net.node(n).segments))];
  const shortBefore = new Set(around.filter((id) => tooShort(net, net.segment(id))));
  seg.profile = { ...seg.profile, forward, backward };
  // A road joining as an entrance can't take a second lane each way where a junction won't fit.
  if ((net.node(seg.a).entrance || net.node(seg.b).entrance) && around.some((id) => !shortBefore.has(id) && tooShort(net, net.segment(id)))) {
    throw new EditError('Not enough room for more lanes here');
  }
  delete seg.turnsA;
  delete seg.turnsB;
  // Widening pays for the new asphalt; narrowing only for repainting.
  const cost = Math.max(roadCost(seg) - before, seg.curve.length * 0.05);
  return { changed: [segId], touched: touchedAround(net, [segId]), cost };
}

/**
 * Moves a junction or road end to `to`; its roads follow. A straight road stays straight; a curved
 * one keeps its bend: the control point next to the moved end moves with it (same direction
 * there), the far one stays. Roads the move takes across others form junctions, as when bending.
 */
export function moveNode(net: RoadNetwork, nodeId: number, to: Vec3): EditResult {
  const node = net.node(nodeId);
  const dx = to[0] - node.pos[0], dz = to[2] - node.pos[2];
  if (Math.hypot(dx, dz) < 0.01) return { changed: [], touched: [], cost: 0 };
  const straight = new Set(node.segments.filter((id) => net.segment(id).curve.straight()));
  node.pos = [to[0], node.pos[1], to[2]];
  let cost = 0;
  for (const id of node.segments) {
    const seg = net.segment(id);
    const A = net.node(seg.a).pos, B = net.node(seg.b).pos;
    if (straight.has(id)) {
      net.setCurve(id, vec3.add(A, vec3.scale(vec3.sub(B, A), 1 / 3)), vec3.add(A, vec3.scale(vec3.sub(B, A), 2 / 3)));
    } else {
      const { p1, p2 } = seg.curve;
      const shift = (c: Vec3, moved: boolean): Vec3 => (moved ? [c[0] + dx, c[1], c[2] + dz] : c);
      net.setCurve(id, shift(p1, seg.a === nodeId), shift(p2, seg.b === nodeId));
    }
    cost += roadCost(net.segment(id));
  }
  const changed = splitCrossings(net, [...node.segments]);
  return { changed, touched: touchedAround(net, changed), cost };
}

/**
 * Upgrade: gives a road another type (lanes, widths, sidewalks, speed) and keeps its shape and
 * junctions. A one-way road keeps its direction; a road that already is this type is reversed if
 * it's one-way (as in Cities: Skylines), else refused.
 */
export function upgradeRoad(net: RoadNetwork, segId: number, profile: LaneProfile): EditResult {
  const seg = net.segment(segId);
  if (seg.ring !== undefined) throw new EditError('Roundabouts have their own lanes: change them with the Edit tool');
  const p = seg.profile;
  // Keep a one-way road's direction: one running b → a takes the preset the same way round.
  const against = p.forward === 0 && p.backward > 0;
  let next: LaneProfile = against ? { ...profile, forward: profile.backward, backward: profile.forward } : { ...profile };
  const same = next.forward === p.forward && next.backward === p.backward && next.laneWidth === p.laneWidth
    && next.sidewalk === p.sidewalk && (next.speedLimit ?? 50) === (p.speedLimit ?? 50);
  if (same) {
    if (p.forward === p.backward) throw new EditError('This road already is that type');
    next = { ...next, forward: p.backward, backward: p.forward };
  }
  const before = roadCost(seg);
  const around = [...new Set([seg.a, seg.b].flatMap((n) => net.node(n).segments))];
  const shortBefore = new Set(around.filter((id) => tooShort(net, net.segment(id))));
  seg.profile = next;
  if ((net.node(seg.a).entrance || net.node(seg.b).entrance) && around.some((id) => !shortBefore.has(id) && tooShort(net, net.segment(id)))) {
    throw new EditError('Not enough room for a wider road here');
  }
  if (next.forward !== p.forward || next.backward !== p.backward) {
    delete seg.turnsA;
    delete seg.turnsB;
  }
  // Widening pays for the new asphalt; otherwise only for repainting.
  const cost = Math.max(roadCost(seg) - before, seg.curve.length * 0.05);
  return { changed: [segId], touched: touchedAround(net, [segId]), cost };
}

export function setSpeed(net: RoadNetwork, segId: number, kmh: number): EditResult {
  const seg = net.segment(segId);
  seg.profile = { ...seg.profile, speedLimit: kmh };
  return { changed: [segId], touched: [segId], cost: 0 };
}

export function setControl(net: RoadNetwork, nodeId: number, control: JunctionControl): void {
  net.node(nodeId).control = control;
}

/** Makes a join an entrance or a full junction (see `RoadNode.entrance`). */
export function setEntrance(net: RoadNetwork, nodeId: number, on: boolean): void {
  const n = net.node(nodeId);
  if (on) {
    if (!net.entranceLayout(nodeId)) throw new EditError('Only a road with one lane each way can join as an entrance');
    n.entrance = true;
  } else {
    delete n.entrance;
    if (crowded(net, nodeId)) throw new EditError("A full junction doesn't fit here: the roads are too close together");
  }
}

/** Turns non-stop lanes on or off at a junction (see `RoadNode.freeFlow`). */
export function setFreeFlow(net: RoadNetwork, nodeId: number, on: boolean): void {
  const n = net.node(nodeId);
  if (on) n.freeFlow = true;
  else delete n.freeFlow;
}

export function setMajor(net: RoadNetwork, nodeId: number, pair: [number, number]): void {
  net.node(nodeId).major = pair;
}

export function setGreen(net: RoadNetwork, nodeId: number, segId: number, seconds: number): void {
  const n = net.node(nodeId);
  n.greens = { ...n.greens, [segId]: Math.max(5, Math.min(90, Math.round(seconds))) };
}

/** Sets the allowed turns (TURN_* bits, 0 = automatic) of one lane arriving at a node. */
export function setTurns(net: RoadNetwork, segId: number, nodeId: number, lane: number, mask: number): void {
  const seg = net.segment(segId);
  const key = seg.b === nodeId ? 'turnsB' : 'turnsA';
  const n = net.lanesAt(seg, nodeId).incoming;
  const arr = (seg[key] ?? []).slice(0, n);
  while (arr.length < n) arr.push(0);
  arr[lane] = mask;
  if (arr.every((m) => m === 0)) delete seg[key];
  else seg[key] = arr;
}

/** Changed roads plus the roads sharing their end nodes (their junction geometry changes too). */
export function touchedAround(net: RoadNetwork, ids: number[], extraNodes: number[] = []): number[] {
  const out = new Set(ids.filter((id) => net.segments.has(id)));
  const nodes = new Set(extraNodes.filter((n) => net.nodes.has(n)));
  for (const id of out) {
    const s = net.segment(id);
    nodes.add(s.a);
    nodes.add(s.b);
  }
  for (const n of nodes) for (const s of net.node(n).segments) out.add(s);
  return [...out];
}

/** An edit that cannot be carried out; the message is shown to the player. */
export class EditError extends Error {}

import { type Vec3, vec3 } from '../core/math';
import { type LaneProfile, type RoadNetwork, type Roundabout } from '../network/network';
import { roadCost } from './cost';
import { EditError, type EditResult, touchedAround } from './ops';

/**
 * Roundabouts. A junction is turned into a ring of one-way arc roads around an island: every
 * road that met at the junction is cut where it reaches the island edge and joins the ring there.
 * The ring circulates anticlockwise seen from above (right-hand traffic), so entering traffic turns
 * right and gives way to traffic already on the ring (see `LaneGraph` and the junction model).
 */

export const RING_MIN_LANES = 1;
export const RING_MAX_LANES = 3;
export const RING_MIN_RADIUS = 5;
export const RING_MAX_RADIUS = 50;
/** Shortest ring road between the junction areas of neighbouring entries (m): room for one car to wait. */
export const MIN_RING_ARC = 5;
/** Ring lanes are a bit wider than street lanes (long vehicles sweep wider in the curve). */
const RING_LANE_WIDTH = 4;
const RING_SPEED = 30;
/** Longest ring piece per curve (rad); longer gaps get extra joints so the arc stays round. */
const MAX_PIECE = (100 * Math.PI) / 180;

/** Default island radius for a ring with this many lanes. */
export const defaultRadius = (lanes: number): number => 8 + 3 * (lanes - 1);

/** Lanes for a new roundabout: enough for the widest approach, 1–3. */
export function defaultLanes(net: RoadNetwork, nodeId: number): number {
  let most = 1;
  for (const sid of net.node(nodeId).segments) {
    const seg = net.segment(sid);
    const l = net.lanesAt(seg, nodeId);
    most = Math.max(most, l.incoming, l.outgoing);
  }
  return Math.min(RING_MAX_LANES, most);
}

/** Direction of travel on the ring at angle θ around the centre (clockwise in atan2 terms). */
const tangent = (th: number): Vec3 => [Math.sin(th), 0, -Math.cos(th)];

export interface RoundaboutResult extends EditResult {
  id: number;
}

/**
 * Turns junction `nodeId` into a roundabout with an island of `radius` metres and `lanes` ring
 * lanes. Reuses `id` if given (resizing keeps the roundabout's identity).
 */
export function makeRoundabout(net: RoadNetwork, nodeId: number, lanes: number, radius: number, id?: number): RoundaboutResult {
  const node = net.node(nodeId);
  if (node.ring !== undefined) throw new EditError('This is already a roundabout');
  if (node.segments.length < 3) throw new EditError('Only junctions of 3 or more roads can become roundabouts');
  if (lanes < RING_MIN_LANES || lanes > RING_MAX_LANES) throw new EditError('Not a valid number of lanes');
  if (radius < RING_MIN_RADIUS || radius > RING_MAX_RADIUS) throw new EditError('Not a valid roundabout size');
  const centre: Vec3 = [...node.pos];
  const dist = (p: Vec3): number => Math.hypot(p[0] - centre[0], p[2] - centre[2]);

  // 1. Where each road leaves the island circle.
  const cuts: { seg: number; t: number; atA: boolean }[] = [];
  let sidewalk = 0;
  for (const sid of node.segments) {
    const seg = net.segment(sid);
    if (seg.a === seg.b) throw new EditError('A looping road meets here');
    sidewalk = Math.max(sidewalk, seg.profile.sidewalk);
    const atA = seg.a === nodeId;
    const at = (u: number): Vec3 => seg.curve.point(atA ? u : 1 - u);
    let lo = -1;
    const N = 64;
    for (let k = 1; k <= N; k++) {
      if (dist(at(k / N)) >= radius) {
        lo = (k - 1) / N;
        break;
      }
    }
    if (lo < 0) throw new EditError('A road here is too short for a roundabout this size');
    let hi = lo + 1 / N;
    for (let it = 0; it < 40; it++) {
      const mid = (lo + hi) / 2;
      if (dist(at(mid)) < radius) lo = mid;
      else hi = mid;
    }
    const u = (lo + hi) / 2;
    cuts.push({ seg: sid, t: atA ? u : 1 - u, atA });
  }

  // 2. Cut the roads there and drop the inner pieces (the junction node goes with them).
  const ringNodes: { id: number; th: number }[] = [];
  const approaches: number[] = [];
  for (const c of cuts) {
    const { node: m, first, second } = net.splitSegment(c.seg, c.t);
    net.removeSegment(c.atA ? first : second);
    const outer = c.atA ? second : first;
    approaches.push(outer);
    const p = net.node(m).pos;
    ringNodes.push({ id: m, th: angleAround(centre, p) });
  }
  ringNodes.sort((a, b) => a.th - b.th);

  // 3. The ring between the entry points.
  const rid = id ?? net.newId();
  const profile: LaneProfile = { forward: lanes, backward: 0, laneWidth: RING_LANE_WIDTH, sidewalk: sidewalk || 2, speedLimit: RING_SPEED };
  const ring = buildRing(net, rid, ringNodes, centre, radius, profile);
  net.roundabouts.set(rid, { id: rid, centre, radius, lanes });
  const cost = ring.reduce((sum, s) => sum + roadCost(net.segment(s)), 0);
  return { id: rid, changed: ring, touched: touchedAround(net, [...ring, ...approaches]), cost };
}

/** Angle of a point around a centre (atan2 convention). */
const angleAround = (c: Vec3, p: Vec3): number => Math.atan2(p[2] - c[2], p[0] - c[0]);

/** Joint angles the ring gets between neighbouring entries (sorted by angle, increasing). */
function jointAngles(entries: { th: number }[]): number[] {
  const out: number[] = [];
  const n = entries.length;
  for (let k = 0; k < n; k++) {
    const from = entries[k]!.th, to = entries[(k - 1 + n) % n]!.th;
    let delta = from - to;
    if (delta <= 0) delta += Math.PI * 2;
    const pieces = Math.ceil(delta / MAX_PIECE);
    for (let j = 1; j < pieces; j++) out.push(from - (delta * j) / pieces);
  }
  return out;
}

/**
 * Builds the ring roads between entry nodes (sorted by angle, increasing): from each entry
 * clockwise in atan2 terms (decreasing angle) to the previous one, with extra joints on long
 * gaps. Marks the nodes and gives the ring right of way at every entry. Returns the ring roads.
 */
function buildRing(net: RoadNetwork, rid: number, entries: { id: number; th: number }[], centre: Vec3, radius: number, profile: LaneProfile): number[] {
  const ring: number[] = [];
  const n = entries.length;
  const onCircle = (th: number): Vec3 => [centre[0] + Math.cos(th) * radius, centre[1], centre[2] + Math.sin(th) * radius];
  for (let k = 0; k < n; k++) {
    const from = entries[k]!, to = entries[(k - 1 + n) % n]!;
    let delta = from.th - to.th;
    if (delta <= 0) delta += Math.PI * 2;
    const pieces = Math.ceil(delta / MAX_PIECE);
    let prev = from.id;
    for (let j = 1; j <= pieces; j++) {
      const th0 = from.th - (delta * (j - 1)) / pieces, th1 = from.th - (delta * j) / pieces;
      const next = j === pieces ? to.id : net.addNode(onCircle(th1));
      const k4 = (4 / 3) * Math.tan((th0 - th1) / 4) * radius;
      const p0 = net.node(prev).pos, p3 = net.node(next).pos;
      const sid = net.addSegment(prev, next, profile, vec3.add(p0, vec3.scale(tangent(th0), k4)), vec3.sub(p3, vec3.scale(tangent(th1), k4)));
      net.segment(sid).ring = rid;
      net.node(next).ring = rid;
      ring.push(sid);
      prev = next;
    }
  }
  for (const e of entries) {
    const nd = net.node(e.id);
    nd.ring = rid;
    const ringIn = nd.segments.find((s) => net.segment(s).ring === rid && net.segment(s).b === e.id)!;
    const ringOut = nd.segments.find((s) => net.segment(s).ring === rid && net.segment(s).a === e.id)!;
    nd.major = [ringIn, ringOut];
    delete nd.control;
    delete nd.greens;
  }
  return ring;
}

/**
 * Keeps rings tidy after edits around them: when roads joined or left a ring, its joints may no
 * longer sit evenly between the entries (a new entry right next to a joint would leave a ring
 * piece shorter than its junction). Such rings are rebuilt in place (same circle, same lanes),
 * and a ring that no road joins any more is removed. Returns the ring roads it built.
 */
export function tidyRoundabouts(net: RoadNetwork): number[] {
  const built: number[] = [];
  for (const r of [...net.roundabouts.values()]) {
    const { segments, nodes } = ringParts(net, r.id);
    const entries = nodes.filter((nid) => net.node(nid).segments.some((s) => net.segment(s).ring !== r.id))
      .map((nid) => ({ id: nid, th: angleAround(r.centre, net.node(nid).pos) }))
      .sort((a, b) => a.th - b.th);
    if (entries.length === 0) {
      removeRing(net, r.id);
      continue;
    }
    const want = jointAngles(entries);
    const joints = nodes.filter((nid) => !entries.some((e) => e.id === nid));
    const tidy = joints.length === want.length && segments.length === entries.length + want.length
      && joints.every((nid) => {
        const p = net.node(nid).pos;
        return want.some((th) => Math.hypot(p[0] - r.centre[0] - Math.cos(th) * r.radius, p[2] - r.centre[2] - Math.sin(th) * r.radius) < 0.5);
      });
    if (tidy) continue;
    const profile = { ...net.segment(segments[0]!).profile };
    for (const sid of segments) net.removeSegment(sid);
    built.push(...buildRing(net, r.id, entries, r.centre, r.radius, profile));
  }
  return built;
}

/** Ring roads and nodes of a roundabout. */
export function ringParts(net: RoadNetwork, id: number): { segments: number[]; nodes: number[] } {
  return {
    segments: [...net.segments.values()].filter((s) => s.ring === id).map((s) => s.id),
    nodes: [...net.nodes.values()].filter((n) => n.ring === id).map((n) => n.id),
  };
}

/** Is a ring road of roundabout `id` shorter between its junction areas than a ring needs? */
export function ringTooSmall(net: RoadNetwork, id: number): boolean {
  for (const sid of ringParts(net, id).segments) {
    const [s0, s1] = net.trimmedRange(net.segment(sid));
    if (s1 - s0 < MIN_RING_ARC) return true;
  }
  return false;
}

/**
 * Turns junction `nodeId` into a roundabout, choosing the lanes (from the widest road) and the
 * smallest island (from the default size up) that leaves room between neighbouring entries.
 */
export function convertToRoundabout(net: RoadNetwork, nodeId: number, lanes = defaultLanes(net, nodeId)): RoundaboutResult {
  for (let r = defaultRadius(lanes); r <= RING_MAX_RADIUS; r++) {
    const trial = net.clone();
    const res = makeRoundabout(trial, nodeId, lanes, r);
    if (!ringTooSmall(trial, res.id)) return makeRoundabout(net, nodeId, lanes, r);
  }
  throw new EditError('Roads meet too close together here for a roundabout');
}

/**
 * Turns a roundabout back into a plain junction at its centre: the roads joining the ring are
 * extended to the centre and the ring is removed. Returns the new junction node.
 */
export function removeRoundabout(net: RoadNetwork, id: number): EditResult & { node: number } {
  const r = net.roundabouts.get(id);
  if (!r) throw new EditError('No such roundabout');
  const { segments: ring, nodes } = ringParts(net, id);
  const centre = net.addNode(r.centre);
  const moved: number[] = [];
  let before = 0;
  for (const nid of nodes) {
    for (const sid of [...net.node(nid).segments]) {
      const seg = net.segment(sid);
      if (seg.ring === id) continue;
      const other = net.otherEnd(seg, nid);
      if (net.node(other).ring === id) throw new EditError('A road links two points of this roundabout: remove it first');
      before += roadCost(seg);
      net.moveEnd(sid, nid, centre);
      moved.push(sid);
    }
  }
  for (const sid of ring) net.removeSegment(sid);
  net.roundabouts.delete(id);
  const cost = Math.max(0, moved.reduce((sum, s) => sum + roadCost(net.segment(s)), 0) - before);
  if (net.node(centre).segments.length === 0) net.nodes.delete(centre);
  return { node: centre, changed: moved, touched: touchedAround(net, moved, [centre]), cost };
}

/** Removes a roundabout's ring entirely; the roads that joined it become dead ends. */
export function removeRing(net: RoadNetwork, id: number): EditResult {
  const { segments: ring, nodes } = ringParts(net, id);
  for (const sid of ring) net.removeSegment(sid);
  for (const nid of nodes) {
    const nd = net.nodes.get(nid);
    if (!nd) continue;
    delete nd.ring;
    delete nd.major;
  }
  net.roundabouts.delete(id);
  return { changed: [], touched: touchedAround(net, [], nodes), cost: 0 };
}

export function setRoundaboutLanes(net: RoadNetwork, id: number, lanes: number): EditResult {
  const r = net.roundabouts.get(id);
  if (!r) throw new EditError('No such roundabout');
  if (lanes < RING_MIN_LANES || lanes > RING_MAX_LANES) throw new EditError(`A roundabout has ${RING_MIN_LANES}–${RING_MAX_LANES} lanes`);
  const { segments: ring } = ringParts(net, id);
  let before = 0, after = 0;
  for (const sid of ring) {
    const seg = net.segment(sid);
    before += roadCost(seg);
    seg.profile = { ...seg.profile, forward: lanes };
    after += roadCost(seg);
  }
  r.lanes = lanes;
  const length = ring.reduce((sum, s) => sum + net.segment(s).curve.length, 0);
  return { changed: ring, touched: touchedAround(net, ring), cost: Math.max(after - before, length * 0.05) };
}

/** Rebuilds a roundabout with a different island radius (same lanes, same id). */
export function setRoundaboutSize(net: RoadNetwork, id: number, radius: number): RoundaboutResult {
  const r = net.roundabouts.get(id);
  if (!r) throw new EditError('No such roundabout');
  if (radius < RING_MIN_RADIUS) throw new EditError('The roundabout cannot be smaller');
  if (radius > RING_MAX_RADIUS) throw new EditError('The roundabout cannot be bigger');
  const lanes = r.lanes;
  const back = removeRoundabout(net, id);
  const res = makeRoundabout(net, back.node, lanes, radius, id);
  return { ...res, touched: [...new Set([...res.touched])] };
}

/** The roundabout whose ring or island is under ground point p (within `tol`), if any. */
export function roundaboutAt(net: RoadNetwork, p: Vec3, tol: number): Roundabout | null {
  let best: Roundabout | null = null, bestD = Infinity;
  for (const r of net.roundabouts.values()) {
    const d = Math.hypot(p[0] - r.centre[0], p[2] - r.centre[2]);
    const outer = r.radius + r.lanes * RING_LANE_WIDTH + tol;
    if (d < outer && d < bestD) [best, bestD] = [r, d];
  }
  return best;
}

/** Outer radius of the ring's asphalt. */
export const outerRadius = (r: Roundabout): number => r.radius + r.lanes * RING_LANE_WIDTH;

import { type Vec3, vec3 } from '../core/math';
import { CubicBezier } from './bezier';

/**
 * Cross-section of a road. Right-hand traffic: looking from node `a` to node `b`,
 * forward lanes are right of the centreline and backward lanes are left of it.
 */
export interface LaneProfile {
  forward: number;
  backward: number;
  laneWidth: number; // metres
  sidewalk: number; // width of each sidewalk, metres (0 = none)
  speedLimit?: number; // km/h, default 50
}

/** How a junction is controlled. 'priority' = main road has right of way, side roads give way. */
export type JunctionControl = 'priority' | 'allway' | 'signal';

/** Turn bits for lane-use overrides (`RoadSegment.turnsA/B`). 0 = automatic rules. */
export const TURN_LEFT = 1;
export const TURN_STRAIGHT = 2;
export const TURN_RIGHT = 4;

export interface RoadNode {
  id: number;
  pos: Vec3;
  segments: number[];
  /** Junction control; defaults to 'priority' at junctions with 3+ roads. */
  control?: JunctionControl;
  /** Priority junctions: the two segments forming the main road (default: chosen automatically). */
  major?: [number, number];
  /** Signal junctions: green time (s) per incoming segment id; a phase uses the max of its arms. */
  greens?: Record<number, number>;
  /** Id of the roundabout this node lies on (where a road meets the ring, or a ring joint). */
  ring?: number;
}

/**
 * A roundabout: a ring of one-way roads (`RoadSegment.ring`) around an island, circulating
 * anticlockwise seen from above (right-hand traffic: island on the driver's left). The ring roads'
 * centrelines run along the island edge, their lanes lie outside it.
 */
export interface Roundabout {
  id: number;
  centre: Vec3;
  /** Island radius (m): distance from the centre to the inner edge of the ring's asphalt. */
  radius: number;
  lanes: number;
}

export interface RoadSegment {
  id: number;
  a: number;
  b: number;
  curve: CubicBezier;
  profile: LaneProfile;
  /**
   * Allowed turns per lane arriving at node a / node b, indexed by lane index (0 = innermost),
   * as TURN_* bit masks. Missing or 0 entries use the automatic lane-use rules.
   */
  turnsA?: number[];
  turnsB?: number[];
  /** Id of the roundabout whose ring this road is part of. */
  ring?: number;
}

/** Plain-data form of a network (levels, undo snapshots). */
export interface NetworkData {
  nextId: number;
  nodes: { id: number; pos: Vec3; control?: JunctionControl; major?: [number, number]; greens?: Record<number, number>; ring?: number }[];
  segments: {
    id: number; a: number; b: number; c1: Vec3; c2: Vec3; profile: LaneProfile; turnsA?: number[]; turnsB?: number[]; ring?: number;
  }[];
  roundabouts?: Roundabout[];
}

/** One road leaving a node, described in an outward-facing frame. */
export interface Arm {
  segment: RoadSegment;
  startsHere: boolean;
  /** Trimmed end of the road at the junction boundary. */
  end: Vec3;
  /** Unit horizontal direction pointing away from the node. */
  dir: Vec3;
  /** Unit horizontal vector to the right of `dir`. */
  right: Vec3;
  /** Asphalt extent left / right of the centreline, in this outward frame. */
  leftExt: number;
  rightExt: number;
  angle: number;
}

/** Extra length beyond the point where neighbouring sidewalk edges meet, for a rounded kerb. */
const KERB_ROOM = 3;
/** Minimum distance from a junction centre to where a road begins. */
const MIN_TRIM = 5;

export const horizontal = (v: Vec3): Vec3 => vec3.normalize([v[0], 0, v[2]]);
export const rightOf = (d: Vec3): Vec3 => [-d[2], 0, d[0]];

export class RoadNetwork {
  readonly nodes = new Map<number, RoadNode>();
  readonly segments = new Map<number, RoadSegment>();
  readonly roundabouts = new Map<number, Roundabout>();
  private nextId = 1;

  /** A fresh id (shared counter with nodes and segments). */
  newId(): number {
    return this.nextId++;
  }

  addNode(pos: Vec3): number {
    const id = this.nextId++;
    this.nodes.set(id, { id, pos: [pos[0], pos[1], pos[2]], segments: [] });
    return id;
  }

  /** Adds a road from a to b. Omit control points for a straight road. */
  addSegment(a: number, b: number, profile: LaneProfile, c1?: Vec3, c2?: Vec3): number {
    const na = this.node(a), nb = this.node(b);
    const curve = c1 && c2 ? new CubicBezier(na.pos, c1, c2, nb.pos) : CubicBezier.line(na.pos, nb.pos);
    const id = this.nextId++;
    this.segments.set(id, { id, a, b, curve, profile: { ...profile } });
    na.segments.push(id);
    nb.segments.push(id);
    return id;
  }

  node(id: number): RoadNode {
    const n = this.nodes.get(id);
    if (!n) throw new Error(`No node ${id}`);
    return n;
  }

  segment(id: number): RoadSegment {
    const s = this.segments.get(id);
    if (!s) throw new Error(`No segment ${id}`);
    return s;
  }

  /** The node at the other end of a segment. */
  otherEnd(seg: RoadSegment, nodeId: number): number {
    return seg.a === nodeId ? seg.b : seg.a;
  }

  /** Removes a road; nodes left without roads are removed too. Junction settings are tidied. */
  removeSegment(id: number): void {
    const seg = this.segment(id);
    this.segments.delete(id);
    for (const nid of [seg.a, seg.b]) {
      const n = this.nodes.get(nid);
      if (!n) continue;
      n.segments = n.segments.filter((s) => s !== id);
      if (n.major?.includes(id)) delete n.major;
      if (n.greens) delete n.greens[id];
      if (n.segments.length === 0) this.nodes.delete(nid);
    }
  }

  /**
   * Moves the end of road `segId` that is at node `from` to node `to`. The road keeps its far end
   * and passes through the old end point: (far, far control, old end, new end).
   */
  moveEnd(segId: number, from: number, to: number): void {
    const seg = this.segment(segId);
    const old = this.node(from), nw = this.node(to);
    const atA = seg.a === from;
    const c = seg.curve;
    seg.curve = atA ? new CubicBezier(nw.pos, old.pos, c.p2, c.p3) : new CubicBezier(c.p0, c.p1, old.pos, nw.pos);
    if (atA) seg.a = to;
    else seg.b = to;
    old.segments = old.segments.filter((s) => s !== segId);
    if (old.major?.includes(segId)) delete old.major;
    if (old.greens) delete old.greens[segId];
    nw.segments.push(segId);
    if (old.segments.length === 0) this.nodes.delete(from);
  }

  /** Replaces the shape of a road, keeping its end nodes. */
  setCurve(id: number, c1: Vec3, c2: Vec3): void {
    const seg = this.segment(id);
    seg.curve = new CubicBezier(this.node(seg.a).pos, c1, c2, this.node(seg.b).pos);
  }

  /**
   * Splits a road at curve parameter t by inserting a node there. Both halves keep the profile;
   * lane-use overrides and junction settings stay with the end they belong to. Returns the new node.
   */
  splitSegment(id: number, t: number, atNode?: number): { node: number; first: number; second: number } {
    const seg = this.segment(id);
    const [c0, c1] = seg.curve.split(t);
    // Optionally split at an existing node lying (almost) on the curve: nudge the halves onto it.
    const mid = atNode ?? this.addNode(c0.p3);
    const m = this.node(mid).pos;
    const off = vec3.sub(m, c0.p3);
    const first = this.addSegment(seg.a, mid, seg.profile, c0.p1, vec3.add(c0.p2, off));
    const second = this.addSegment(mid, seg.b, seg.profile, vec3.add(c1.p1, off), c1.p2);
    if (seg.turnsA) this.segment(first).turnsA = [...seg.turnsA];
    if (seg.turnsB) this.segment(second).turnsB = [...seg.turnsB];
    if (seg.ring !== undefined) {
      // A new point on a roundabout ring: the ring has right of way there.
      this.segment(first).ring = seg.ring;
      this.segment(second).ring = seg.ring;
      const n = this.node(mid);
      n.ring = seg.ring;
      n.major = [first, second];
    }
    const rename = (nodeId: number, to: number): void => {
      const n = this.node(nodeId);
      n.segments = n.segments.filter((s) => s !== id && s !== to);
      n.segments.push(to);
      if (n.major) n.major = n.major.map((s) => (s === id ? to : s)) as [number, number];
      if (n.greens && n.greens[id] !== undefined) {
        n.greens[to] = n.greens[id]!;
        delete n.greens[id];
      }
    };
    rename(seg.a, first);
    rename(seg.b, second);
    this.segments.delete(id);
    return { node: mid, first, second };
  }

  toData(): NetworkData {
    return {
      nextId: this.nextId,
      nodes: [...this.nodes.values()].map((n) => ({
        id: n.id, pos: [...n.pos] as Vec3,
        ...(n.control ? { control: n.control } : {}),
        ...(n.major ? { major: [...n.major] as [number, number] } : {}),
        ...(n.greens ? { greens: { ...n.greens } } : {}),
        ...(n.ring !== undefined ? { ring: n.ring } : {}),
      })),
      segments: [...this.segments.values()].map((s) => ({
        id: s.id, a: s.a, b: s.b, c1: [...s.curve.p1] as Vec3, c2: [...s.curve.p2] as Vec3, profile: { ...s.profile },
        ...(s.turnsA ? { turnsA: [...s.turnsA] } : {}),
        ...(s.turnsB ? { turnsB: [...s.turnsB] } : {}),
        ...(s.ring !== undefined ? { ring: s.ring } : {}),
      })),
      ...(this.roundabouts.size > 0
        ? { roundabouts: [...this.roundabouts.values()].map((r) => ({ ...r, centre: [...r.centre] as Vec3 })) }
        : {}),
    };
  }

  static fromData(d: NetworkData): RoadNetwork {
    const net = new RoadNetwork();
    for (const n of d.nodes) {
      const node: RoadNode = { id: n.id, pos: [...n.pos] as Vec3, segments: [] };
      if (n.control) node.control = n.control;
      if (n.major) node.major = [...n.major];
      if (n.greens) node.greens = { ...n.greens };
      if (n.ring !== undefined) node.ring = n.ring;
      net.nodes.set(n.id, node);
    }
    for (const s of d.segments) {
      const na = net.node(s.a), nb = net.node(s.b);
      const seg: RoadSegment = {
        id: s.id, a: s.a, b: s.b, profile: { ...s.profile },
        curve: new CubicBezier(na.pos, [...s.c1] as Vec3, [...s.c2] as Vec3, nb.pos),
      };
      if (s.turnsA) seg.turnsA = [...s.turnsA];
      if (s.turnsB) seg.turnsB = [...s.turnsB];
      if (s.ring !== undefined) seg.ring = s.ring;
      net.segments.set(s.id, seg);
      na.segments.push(s.id);
      nb.segments.push(s.id);
    }
    for (const r of d.roundabouts ?? []) net.roundabouts.set(r.id, { ...r, centre: [...r.centre] as Vec3 });
    net.nextId = d.nextId;
    return net;
  }

  clone(): RoadNetwork {
    return RoadNetwork.fromData(this.toData());
  }

  /** Lanes arriving at / leaving a node along a segment. */
  lanesAt(seg: RoadSegment, nodeId: number): { incoming: number; outgoing: number } {
    const { forward, backward } = seg.profile;
    return seg.b === nodeId ? { incoming: forward, outgoing: backward } : { incoming: backward, outgoing: forward };
  }

  /** Untrimmed horizontal direction of a segment leaving the node. */
  private leaveDir(seg: RoadSegment, nodeId: number): Vec3 {
    const d = horizontal(seg.curve.derivative(seg.a === nodeId ? 0 : 1));
    return seg.a === nodeId ? d : vec3.scale(d, -1);
  }

  /**
   * Nodes that need their own surface: 3+ roads, 2 roads meeting at an angle, or 2 roads with
   * different cross-sections (lanes are added or dropped there). A straight 2-road node with the
   * same cross-section is just a seamless continuation.
   */
  isJunction(nodeId: number): boolean {
    const segs = this.node(nodeId).segments;
    if (segs.length >= 3) return true;
    if (segs.length < 2) return false;
    const s0 = this.segments.get(segs[0]!)!, s1 = this.segments.get(segs[1]!)!;
    const d0 = this.leaveDir(s0, nodeId);
    const d1 = this.leaveDir(s1, nodeId);
    if (vec3.dot(d0, d1) > -0.985) return true; // more than ~10° away from a straight continuation
    const l0 = this.lanesAt(s0, nodeId), l1 = this.lanesAt(s1, nodeId);
    const p0 = s0.profile, p1 = s1.profile;
    return l0.incoming !== l1.outgoing || l0.outgoing !== l1.incoming
      || p0.laneWidth !== p1.laneWidth || p0.sidewalk !== p1.sidewalk;
  }

  /**
   * Smallest junction size. Where 2 roads continue straight (a lane-count change) the taper
   * needs room to merge; elsewhere the clearance between neighbouring roads decides (`armTrim`).
   */
  private baseRadius(nodeId: number): number {
    const segs = this.node(nodeId).segments;
    if (segs.length === 2) {
      const d0 = this.leaveDir(this.segments.get(segs[0]!)!, nodeId);
      const d1 = this.leaveDir(this.segments.get(segs[1]!)!, nodeId);
      if (vec3.dot(d0, d1) < -0.985) {
        let half = 0, walk = 0;
        for (const sid of segs) {
          const p = this.segments.get(sid)!.profile;
          half = Math.max(half, Math.max(p.forward, p.backward) * p.laneWidth);
          walk = Math.max(walk, p.sidewalk);
        }
        return half + walk + 3;
      }
    }
    return MIN_TRIM;
  }

  /**
   * Distance from the node centre at which road `segId` stops and the junction surface begins:
   * where its outer sidewalk edge clears the edges of the neighbouring roads, plus room for a
   * rounded kerb. A narrow street joining an avenue therefore pulls the avenue back only a little,
   * and at acute angles roads are pulled back far enough that sidewalks never overlap.
   */
  armTrim(nodeId: number, segId: number): number {
    if (!this.isJunction(nodeId)) return 0;
    const base = this.baseRadius(nodeId);
    const arms = this.node(nodeId).segments.map((sid) => {
      const seg = this.segments.get(sid)!;
      const dir = this.leaveDir(seg, nodeId);
      const { incoming, outgoing } = this.lanesAt(seg, nodeId);
      const { laneWidth: w, sidewalk: sw } = seg.profile;
      // Outward frame: outgoing lanes are on the right, incoming on the left.
      return { id: sid, dir, right: rightOf(dir), L: incoming * w + sw, R: outgoing * w + sw, angle: Math.atan2(dir[2], dir[0]) };
    }).sort((p, q) => p.angle - q.angle);
    const n = arms.length;
    const i = arms.findIndex((a) => a.id === segId);
    if (i < 0 || n < 2) return base;
    let trim = base;
    const pair = (a: (typeof arms)[number], c: (typeof arms)[number], mine: 'a' | 'c'): void => {
      let gap = c.angle - a.angle;
      if (gap <= 0) gap += Math.PI * 2;
      if (gap >= Math.PI - 0.05) return; // edges diverge: no constraint
      // Right outer edge of a: t·dirA + R_a·rightA; left outer edge of c: u·dirC − L_c·rightC.
      const px = a.right[0] * a.R, pz = a.right[2] * a.R;
      const qx = -c.right[0] * c.L, qz = -c.right[2] * c.L;
      const den = a.dir[0] * -c.dir[2] - a.dir[2] * -c.dir[0];
      if (Math.abs(den) < 1e-6) return;
      const rx = qx - px, rz = qz - pz;
      const t = (rx * -c.dir[2] - rz * -c.dir[0]) / den;
      const u = (a.dir[0] * rz - a.dir[2] * rx) / den;
      const d = mine === 'a' ? t : u;
      if (d > 0) trim = Math.max(trim, d + KERB_ROOM);
    };
    pair(arms[i]!, arms[(i + 1) % n]!, 'a');
    pair(arms[(i - 1 + n) % n]!, arms[i]!, 'c');
    return trim;
  }

  /** Largest distance from the node centre to where its roads begin (size of the junction area). */
  junctionRadius(nodeId: number): number {
    if (!this.isJunction(nodeId)) return 0;
    return Math.max(...this.node(nodeId).segments.map((s) => this.armTrim(nodeId, s)));
  }

  /** Arc-length range of the segment that is drawn as road (outside junction areas). */
  trimmedRange(seg: RoadSegment): [number, number] {
    const s0 = this.armTrim(seg.a, seg.id);
    const s1 = seg.curve.length - this.armTrim(seg.b, seg.id);
    return s1 > s0 ? [s0, s1] : [seg.curve.length / 2, seg.curve.length / 2];
  }

  /** Roads leaving a node, sorted by angle (atan2(z, x), increasing). */
  arms(nodeId: number): Arm[] {
    const arms: Arm[] = [];
    for (const sid of this.node(nodeId).segments) {
      const seg = this.segments.get(sid)!;
      const [s0, s1] = this.trimmedRange(seg);
      const startsHere = seg.a === nodeId;
      const t = seg.curve.tAtDistance(startsHere ? s0 : s1);
      const tan = horizontal(seg.curve.derivative(t));
      const dir = startsHere ? tan : vec3.scale(tan, -1);
      const { forward, backward, laneWidth } = seg.profile;
      arms.push({
        segment: seg,
        startsHere,
        end: seg.curve.point(t),
        dir,
        right: rightOf(dir),
        leftExt: (startsHere ? backward : forward) * laneWidth,
        rightExt: (startsHere ? forward : backward) * laneWidth,
        angle: Math.atan2(dir[2], dir[0]),
      });
    }
    return arms.sort((p, q) => p.angle - q.angle);
  }
}

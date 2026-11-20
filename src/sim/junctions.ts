import { vec3 } from '../core/math';
import { type JunctionControl, rightOf } from '../network/network';
import type { Lane, LaneGraph } from './laneGraph';
import type { Path } from './path';

/** Paths closer than this (m, centreline to centreline) are treated as conflicting. */
const CONFLICT_DIST = 1.9;
const MERGE_ZONE = 3.5;
const MERGE_DIST = 2.3; // merging paths closer than this share the zone
const YELLOW = 3;
const ALL_RED = 2;

/** Default green time (s) for an approach with `lanes` lanes. */
export const defaultGreen = (lanes: number): number => 10 + 8 * lanes;

export const SIGNAL_GREEN = 0;
export const SIGNAL_YELLOW = 1;
export const SIGNAL_RED = 2;

/** Where connector `self` crosses or merges with connector `other`, seen from `self`. */
export interface Conflict {
  other: number;
  /** Distance along self / other to the centre of the conflict zone. */
  sSelf: number;
  sOther: number;
  /** Half-length of the zone along self / along other (m). */
  h: number;
  hOther: number;
  /** True if a vehicle on self must give way to one on other. */
  yields: boolean;
}

export interface Phase {
  /** Incoming road segments that get green in this phase. */
  arms: number[];
  connectors: number[];
  green: number;
}

/** Fixed-time signal: phases in order, each followed by yellow and all-red. */
export class SignalController {
  private t = 0;
  readonly cycle: number;
  private readonly phaseOf = new Map<number, number>();

  constructor(readonly node: number, readonly phases: Phase[]) {
    this.cycle = phases.reduce((s, p) => s + p.green + YELLOW + ALL_RED, 0);
    phases.forEach((p, k) => p.connectors.forEach((c) => this.phaseOf.set(c, k)));
  }

  update(dt: number): void {
    this.t = (this.t + dt) % this.cycle;
  }

  /** SIGNAL_GREEN / SIGNAL_YELLOW / SIGNAL_RED for a connector of this junction. */
  state(connector: number): number {
    const p = this.phaseOf.get(connector);
    if (p === undefined) return SIGNAL_GREEN;
    let t = this.t;
    for (let k = 0; k < this.phases.length; k++) {
      const ph = this.phases[k]!;
      const span = ph.green + YELLOW + ALL_RED;
      if (t < span) {
        if (k !== p) return SIGNAL_RED;
        return t < ph.green ? SIGNAL_GREEN : t < ph.green + YELLOW ? SIGNAL_YELLOW : SIGNAL_RED;
      }
      t -= span;
    }
    return SIGNAL_RED;
  }
}

/** Closest approach of two 2D segments (XZ). Returns [t on a, u on b, distance]. */
function segSeg(ax: number, az: number, bx: number, bz: number, cx: number, cz: number, dx: number, dz: number): [number, number, number] {
  const rx = bx - ax, rz = bz - az, sx = dx - cx, sz = dz - cz;
  const den = rx * sz - rz * sx;
  if (Math.abs(den) > 1e-9) {
    const t = ((cx - ax) * sz - (cz - az) * sx) / den;
    const u = ((cx - ax) * rz - (cz - az) * rx) / den;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return [t, u, 0];
  }
  // No proper intersection: best of the four endpoint-to-segment distances.
  const pt = (px: number, pz: number, ox: number, oz: number, vx: number, vz: number): [number, number] => {
    const l2 = vx * vx + vz * vz;
    const k = l2 > 0 ? Math.max(0, Math.min(1, ((px - ox) * vx + (pz - oz) * vz) / l2)) : 0;
    return [k, Math.hypot(px - (ox + vx * k), pz - (oz + vz * k))];
  };
  let best: [number, number, number] = [0, 0, Infinity];
  const [u0, d0] = pt(ax, az, cx, cz, sx, sz); if (d0 < best[2]) best = [0, u0, d0];
  const [u1, d1] = pt(bx, bz, cx, cz, sx, sz); if (d1 < best[2]) best = [1, u1, d1];
  const [t0, d2] = pt(cx, cz, ax, az, rx, rz); if (d2 < best[2]) best = [t0, 0, d2];
  const [t1, d3] = pt(dx, dz, ax, az, rx, rz); if (d3 < best[2]) best = [t1, 1, d3];
  return best;
}

/** First point along `a` where it comes within CONFLICT_DIST of `b`, with the crossing angle. */
function firstConflict(a: Path, b: Path, within = CONFLICT_DIST): { sa: number; sb: number; angle: number } | null {
  const A = a.pts, B = b.pts;
  for (let i = 0; i + 1 < a.count; i++) {
    let best: { sa: number; sb: number; angle: number; d: number } | null = null;
    for (let j = 0; j + 1 < b.count; j++) {
      const [t, u, d] = segSeg(A[i * 3]!, A[i * 3 + 2]!, A[i * 3 + 3]!, A[i * 3 + 5]!, B[j * 3]!, B[j * 3 + 2]!, B[j * 3 + 3]!, B[j * 3 + 5]!);
      if (d < within && (!best || d < best.d)) {
        const ra = Math.atan2(A[i * 3 + 5]! - A[i * 3 + 2]!, A[i * 3 + 3]! - A[i * 3]!);
        const rb = Math.atan2(B[j * 3 + 5]! - B[j * 3 + 2]!, B[j * 3 + 3]! - B[j * 3]!);
        best = {
          sa: a.cum[i]! + t * (a.cum[i + 1]! - a.cum[i]!),
          sb: b.cum[j]! + u * (b.cum[j + 1]! - b.cum[j]!),
          angle: Math.abs(Math.sin(ra - rb)),
          d,
        };
      }
    }
    if (best) return best;
  }
  return null;
}

/** Distance along `a` after which every later point of `a` is at least 2.3 m from path `b`. */
function separation(a: Path, b: Path): number {
  const A = a.pts, B = b.pts;
  let sep = 0;
  for (let i = 0; i < a.count; i++) {
    let d = Infinity;
    for (let j = 0; j + 1 < b.count; j++) {
      const [, , dd] = segSeg(A[i * 3]!, A[i * 3 + 2]!, A[i * 3]!, A[i * 3 + 2]!, B[j * 3]!, B[j * 3 + 2]!, B[j * 3 + 3]!, B[j * 3 + 5]!);
      d = Math.min(d, dd);
    }
    if (d < 2.3) sep = a.cum[i]!;
  }
  return sep;
}

const TURN_RANK = { straight: 3, right: 2, left: 1 } as const;

/**
 * Static junction knowledge for the simulation: control type per node, conflict zones per
 * connector with right-of-way, signal controllers, and the incoming lanes of each junction.
 */
export class JunctionModel {
  readonly control = new Map<number, JunctionControl>();
  readonly conflicts: Conflict[][];
  readonly conflictSet: Set<number>[];
  readonly signals = new Map<number, SignalController>();
  /** Signal controller per lane (connectors at signalised nodes), else null. */
  readonly signalOf: (SignalController | null)[];
  /** Road lanes that end at each controlled junction. */
  readonly incoming = new Map<number, number[]>();
  /** Major-road segments at priority junctions. */
  readonly major = new Map<number, Set<number>>();
  /**
   * For connectors that split from the same lane: distance along `a` until it is clear of `b`
   * (key a * 65536 + b). Until then vehicles on the two connectors must keep their distance.
   */
  private readonly split = new Map<number, number>();

  /** See `split`. Returns 0 for connectors that don't share a start lane. */
  splitDistance(a: number, b: number): number {
    return this.split.get(a * 65536 + b) ?? 0;
  }

  constructor(readonly graph: LaneGraph) {
    const { lanes, net } = graph;
    this.conflicts = lanes.map(() => []);
    this.conflictSet = lanes.map(() => new Set());
    this.signalOf = lanes.map(() => null);

    const byNode = new Map<number, Lane[]>();
    for (const l of lanes) {
      if (l.kind !== 'connector') continue;
      let list = byNode.get(l.node);
      if (!list) byNode.set(l.node, (list = []));
      list.push(l);
    }

    for (const [nodeId, conns] of byNode) {
      const node = net.node(nodeId);
      if (node.segments.length < 3) {
        // Bends and lane-count changes: no crossing traffic, but dropped lanes merge.
        const merges = conns.some((a) => conns.some((b) => a !== b && a.next[0] === b.next[0]));
        if (!merges) continue;
        this.control.set(nodeId, 'priority');
        this.incoming.set(nodeId, [...new Set(conns.map((c) => c.prev[0]!))]);
        this.major.set(nodeId, new Set(node.segments));
      } else {
        const control = node.control ?? 'priority';
        this.control.set(nodeId, control);
        this.incoming.set(nodeId, [...new Set(conns.map((c) => c.prev[0]!))]);
        if (control === 'priority') this.major.set(nodeId, this.majorRoad(nodeId));
        if (control === 'signal') this.buildSignal(nodeId, conns);
      }

      for (let x = 0; x < conns.length; x++) {
        for (let y = x + 1; y < conns.length; y++) this.addConflict(nodeId, conns[x]!, conns[y]!);
      }
    }
  }

  /** The two arms with the highest capacity (preferring a straight-through pair) form the main road. */
  private majorRoad(nodeId: number): Set<number> {
    const chosen = this.graph.net.node(nodeId).major;
    if (chosen && chosen.every((s) => this.graph.net.node(nodeId).segments.includes(s))) return new Set(chosen);
    const arms = this.graph.net.arms(nodeId);
    const rank = (i: number): number => {
      const p = arms[i]!.segment.profile;
      return (p.forward + p.backward) * (p.speedLimit ?? 50);
    };
    let best: [number, number] = [0, 1], bestScore = -Infinity;
    for (let i = 0; i < arms.length; i++) {
      for (let j = i + 1; j < arms.length; j++) {
        const straight = vec3.dot(arms[i]!.dir, arms[j]!.dir) < -0.7 ? 1e6 : 0;
        const score = straight + rank(i) + rank(j);
        if (score > bestScore) [best, bestScore] = [[i, j], score];
      }
    }
    return new Set(best.map((k) => arms[k]!.segment.id));
  }

  /** One phase per pair of opposite approaches (or single approach), green scaled by lane count. */
  private buildSignal(nodeId: number, conns: Lane[]): void {
    const lanes = this.graph.lanes;
    const armDir = new Map<number, ReturnType<Path['dirAt']>>();
    const armLanes = new Map<number, number>();
    for (const id of this.incoming.get(nodeId)!) {
      const l = lanes[id]!;
      armDir.set(l.segment, l.path.dirAt(true));
      armLanes.set(l.segment, (armLanes.get(l.segment) ?? 0) + 1);
    }
    const arms = [...armDir.keys()];
    const used = new Set<number>();
    const phases: Phase[] = [];
    for (const a of arms) {
      if (used.has(a)) continue;
      used.add(a);
      const group = [a];
      const opp = arms.find((b) => !used.has(b) && vec3.dot(armDir.get(a)!, armDir.get(b)!) < -0.7);
      if (opp !== undefined) {
        used.add(opp);
        group.push(opp);
      }
      const greens = this.graph.net.node(nodeId).greens ?? {};
      const green = Math.max(...group.map((g) => greens[g] ?? defaultGreen(armLanes.get(g)!)));
      phases.push({
        arms: group,
        connectors: conns.filter((c) => group.includes(lanes[c.prev[0]!]!.segment)).map((c) => c.id),
        green,
      });
    }
    const ctrl = new SignalController(nodeId, phases);
    this.signals.set(nodeId, ctrl);
    for (const c of conns) this.signalOf[c.id] = ctrl;
  }

  /** Does a vehicle on connector a have to give way to one on b? */
  private yields(nodeId: number, a: Lane, b: Lane): boolean {
    const lanes = this.graph.lanes;
    const major = this.major.get(nodeId);
    if (major) {
      const ma = major.has(lanes[a.prev[0]!]!.segment), mb = major.has(lanes[b.prev[0]!]!.segment);
      if (ma !== mb) return mb;
    }
    const ra = TURN_RANK[a.turn ?? 'straight'], rb = TURN_RANK[b.turn ?? 'straight'];
    if (ra !== rb) return ra < rb;
    // Same rank: give way to traffic coming from the right.
    const side = vec3.dot(b.path.dirAt(false), rightOf(a.path.dirAt(false)));
    if (Math.abs(side) > 0.3 || a.next[0] !== b.next[0]) return side < -0.3;
    // Side-by-side lanes merging into one (lane drop): the lane further out gives way.
    return a.index !== b.index ? a.index > b.index : a.id > b.id;
  }

  private addConflict(nodeId: number, a: Lane, b: Lane): void {
    if (a.prev[0] === b.prev[0]) {
      // Diverging from the same lane: no right-of-way question, but record where they separate.
      this.split.set(a.id * 65536 + b.id, separation(a.path, b.path));
      this.split.set(b.id * 65536 + a.id, separation(b.path, a.path));
      return;
    }
    let sa: number, sb: number, ha: number, hb: number;
    if (a.next[0] === b.next[0]) {
      // Merging into the same lane: the zone runs from where the paths get close to the end.
      const ca = firstConflict(a.path, b.path, MERGE_DIST)?.sa ?? a.path.length - MERGE_ZONE;
      const cb = firstConflict(b.path, a.path, MERGE_DIST)?.sa ?? b.path.length - MERGE_ZONE;
      ha = (a.path.length - ca) / 2 + 0.5;
      hb = (b.path.length - cb) / 2 + 0.5;
      sa = a.path.length - ha + 0.5;
      sb = b.path.length - hb + 0.5;
    } else {
      const ab = firstConflict(a.path, b.path);
      if (!ab) return;
      sa = ab.sa; sb = ab.sb;
      const h = Math.min(6, 1.2 / Math.max(ab.angle, 0.25) + 1);
      ha = hb = h;
    }
    this.conflicts[a.id]!.push({ other: b.id, sSelf: sa, sOther: sb, h: ha, hOther: hb, yields: this.yields(nodeId, a, b) });
    this.conflicts[b.id]!.push({ other: a.id, sSelf: sb, sOther: sa, h: hb, hOther: ha, yields: this.yields(nodeId, b, a) });
    this.conflictSet[a.id]!.add(b.id);
    this.conflictSet[b.id]!.add(a.id);
  }

  update(dt: number): void {
    for (const s of this.signals.values()) s.update(dt);
  }
}

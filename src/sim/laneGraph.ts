import { type Vec3, vec3 } from '../core/math';
import { CubicBezier } from '../network/bezier';
import {
  type RoadNetwork, TURN_LEFT, TURN_RIGHT, TURN_STRAIGHT, horizontal, rightOf,
} from '../network/network';
import { Path } from './path';

const LANE_Y = 0.03; // road surface lift (matches roadMesh LIFT)
export const MAX_LAT_ACCEL = 3.0; // m/s², comfortable cornering
/** Drivers start braking for a bend once reaching its speed needs this much deceleration (m/s²). */
export const CURVE_BRAKE = 1.3;
const STRAIGHT_COS = Math.cos((35 * Math.PI) / 180);

export type Turn = 'straight' | 'left' | 'right';
export const TURN_BIT: Record<Turn, number> = { left: TURN_LEFT, straight: TURN_STRAIGHT, right: TURN_RIGHT };

export interface Lane {
  id: number;
  kind: 'road' | 'connector';
  /** Road segment for road lanes, -1 for connectors. */
  segment: number;
  /** Junction node for connectors, -1 for road lanes. */
  node: number;
  fromNode: number;
  toNode: number;
  /** 0 = innermost lane (next to the centre line), increasing towards the kerb. */
  index: number;
  /** Road lanes: index into `LaneGraph.groups` (parallel lanes, same road and direction). -1 for connectors. */
  group: number;
  /** Lane width in metres. */
  width: number;
  turn: Turn | null;
  path: Path;
  /** m/s */
  speedLimit: number;
  /** Cornering speed (m/s, at speed factor 1) at each path point: the speed limit, or lower in bends. */
  safe: Float32Array;
  /** Stretches slower than the speed limit, as [start s, end s, lowest speed] triples. */
  bends: Float32Array;
  /** True when the lane has a bend to slow down for. */
  curved: boolean;
  next: number[];
  prev: number[];
}

/** Lane-level graph derived from the road network: road lanes plus connectors through junctions. */
export class LaneGraph {
  readonly lanes: Lane[] = [];
  /** Parallel road lanes (same segment and direction), ordered by `index`. */
  readonly groups: number[][] = [];
  /** Dead-end nodes where vehicles enter (outgoing lanes) / leave (incoming lanes) the scene. */
  readonly sources = new Map<number, number[]>();
  readonly sinks = new Map<number, number[]>();
  /**
   * For each road lane arriving at a junction: every turn the road layout offers from its arm
   * (TURN_* bits), whether or not this lane is allowed to take it.
   */
  readonly armTurns = new Map<number, number>();
  /** Connectors that carry roundabout traffic on around the ring. */
  readonly circulating = new Set<number>();

  constructor(readonly net: RoadNetwork) {
    const incoming = new Map<number, Map<number, Lane[]>>(); // node → segment → lanes ending there
    const outgoing = new Map<number, Map<number, Lane[]>>();
    const group = (m: Map<number, Map<number, Lane[]>>, node: number, seg: number, l: Lane): void => {
      let bySeg = m.get(node);
      if (!bySeg) m.set(node, (bySeg = new Map()));
      let list = bySeg.get(seg);
      if (!list) bySeg.set(seg, (list = []));
      list.push(l);
    };

    // 1. Road lanes.
    for (const seg of net.segments.values()) {
      const { forward, backward, laneWidth, speedLimit = 50 } = seg.profile;
      const [s0, s1] = net.trimmedRange(seg);
      const n = Math.max(2, seg.curve.pieces(s0, s1, 2));
      const centre: Vec3[] = [], rights: Vec3[] = [];
      for (let k = 0; k <= n; k++) {
        const t = seg.curve.tAtDistance(s0 + ((s1 - s0) * k) / n);
        centre.push(seg.curve.point(t));
        rights.push(rightOf(horizontal(seg.curve.derivative(t))));
      }
      const offset = (u: number): Vec3[] =>
        centre.map((p, k) => vec3.add(p, vec3.add(vec3.scale(rights[k]!, u), [0, LANE_Y, 0])));
      const fwd: number[] = [], bwd: number[] = [];
      for (let i = 0; i < forward; i++) {
        const l = this.add('road', seg.id, -1, seg.a, seg.b, i, null, new Path(offset((i + 0.5) * laneWidth)), speedLimit / 3.6);
        l.width = laneWidth;
        fwd.push(l.id);
        group(outgoing, seg.a, seg.id, l);
        group(incoming, seg.b, seg.id, l);
      }
      for (let i = 0; i < backward; i++) {
        const l = this.add('road', seg.id, -1, seg.b, seg.a, i, null, new Path(offset(-(i + 0.5) * laneWidth).reverse()), speedLimit / 3.6);
        l.width = laneWidth;
        bwd.push(l.id);
        group(outgoing, seg.b, seg.id, l);
        group(incoming, seg.a, seg.id, l);
      }
      for (const ids of [fwd, bwd]) {
        if (ids.length === 0) continue;
        for (const id of ids) this.lanes[id]!.group = this.groups.length;
        this.groups.push(ids);
      }
    }
    for (const m of [incoming, outgoing]) for (const bySeg of m.values()) for (const ls of bySeg.values()) ls.sort((a, b) => a.index - b.index);

    // 2. Connections at every node.
    for (const node of net.nodes.values()) {
      const ins = incoming.get(node.id) ?? new Map<number, Lane[]>();
      const outs = outgoing.get(node.id) ?? new Map<number, Lane[]>();
      if (node.segments.length === 1) {
        for (const ls of ins.values()) this.sinks.set(node.id, ls.map((l) => l.id));
        for (const ls of outs.values()) this.sources.set(node.id, ls.map((l) => l.id));
        continue;
      }
      const junction = net.isJunction(node.id);
      const twoWay = node.segments.length === 2;
      if (node.ring !== undefined && junction) {
        this.connectRing(node.id, node.ring, ins, outs);
        continue;
      }
      for (const [inSeg, inLanes] of ins) {
        const exits = [...outs].filter(([seg]) => seg !== inSeg); // no U-turns
        const hasStraight = exits.some(([, ls]) => this.classify(inLanes[0]!, ls[0]!) === 'straight');
        let possible = 0;
        for (const [, ls] of exits) possible |= TURN_BIT[this.classify(inLanes[0]!, ls[0]!)];
        for (const l of inLanes) this.armTurns.set(l.id, possible);
        for (const [, outLanes] of exits) this.connect(node.id, inLanes, outLanes, junction, twoWay, hasStraight);
        // Guarantee every incoming lane can continue somewhere.
        for (const l of inLanes) {
          if (l.next.length > 0) continue;
          const best = this.bestExit(l, outs, inSeg);
          if (best) this.link(node.id, l, best, junction, this.classify(l, best));
        }
      }
    }
  }

  private add(kind: Lane['kind'], segment: number, node: number, from: number, to: number, index: number,
    turn: Turn | null, path: Path, speedLimit: number): Lane {
    // Connectors already have one speed for the whole turn (see `link`).
    const safe = kind === 'road' ? safeSpeeds(path, speedLimit) : new Float32Array(path.count).fill(speedLimit);
    const bends = slowStretches(path, safe, speedLimit);
    const lane: Lane = {
      id: this.lanes.length, kind, segment, node, fromNode: from, toNode: to, index, group: -1, width: 3.25,
      turn, path, speedLimit, safe, bends, curved: bends.length > 0, next: [], prev: [],
    };
    this.lanes.push(lane);
    return lane;
  }

  /**
   * Where roads join a roundabout ring (lane index 0 = innermost, next to the island):
   *  - ring lanes continue around the ring, lane for lane;
   *  - exits are taken from the outer ring lanes, kerb-aligned (outer ring lane → kerb lane),
   *    so drivers on inner lanes move out first or go round again;
   *  - entering lanes are spread over all ring lanes, kerb lane → outer ring lane.
   * Any lane counts work: lanes are spread so every lane on both sides gets a connection.
   */
  private connectRing(node: number, ring: number, ins: Map<number, Lane[]>, outs: Map<number, Lane[]>): void {
    const net = this.net;
    let ringIn: Lane[] = [], ringOut: Lane[] = [];
    for (const [sid, ls] of ins) if (net.segment(sid).ring === ring) ringIn = ls;
    for (const [sid, ls] of outs) if (net.segment(sid).ring === ring) ringOut = ls;
    const outerFirst = (ls: Lane[]): Lane[] => [...ls].sort((a, b) => b.index - a.index);
    const rin = outerFirst(ringIn), rout = outerFirst(ringOut);
    const m = rout.length;
    for (const l of ringIn) {
      if (m === 0) continue;
      this.link(node, l, ringOut.find((o) => o.index === Math.min(l.index, m - 1))!, true, 'straight');
      this.circulating.add(l.next[l.next.length - 1]!);
    }
    for (const [sid, ls] of outs) {
      if (net.segment(sid).ring === ring || rin.length === 0) continue;
      spread(Math.min(rin.length, ls.length), ls.length, (i, j) => this.link(node, rin[i]!, outerFirst(ls)[j]!, true, 'right'));
    }
    for (const [sid, ls] of ins) {
      if (net.segment(sid).ring === ring) continue;
      for (const l of ls) this.armTurns.set(l.id, m > 0 ? TURN_RIGHT : 0);
      if (m === 0) continue;
      const entry = outerFirst(ls);
      spread(entry.length, m, (i, j) => this.link(node, entry[i]!, rout[j]!, true, 'right'));
    }
  }

  private classify(a: Lane, b: Lane): Turn {
    const dIn = a.path.dirAt(true), dOut = b.path.dirAt(false);
    if (vec3.dot(dIn, dOut) > STRAIGHT_COS) return 'straight';
    return vec3.dot(dOut, rightOf(dIn)) > 0 ? 'right' : 'left';
  }

  private bestExit(l: Lane, outs: Map<number, Lane[]>, inSeg: number): Lane | null {
    let best: Lane | null = null, bestDot = -2;
    for (const [seg, lanes] of outs) {
      if (seg === inSeg) continue;
      const d = vec3.dot(l.path.dirAt(true), lanes[0]!.path.dirAt(false));
      if (d > bestDot) [best, bestDot] = [lanes[0]!, d];
    }
    return best;
  }

  /**
   * Lane-use rules (right-hand traffic) for one incoming arm → one exit:
   *  - every lane may go straight; the innermost lane turns left; the kerb lane turns right;
   *  - with no straight exit (T-junction stem) all lanes except the innermost turn right;
   *  - at a plain 2-road node lanes simply continue (lane i → lane i).
   */
  private connect(node: number, inLanes: Lane[], outLanes: Lane[], junction: boolean, twoWay: boolean, hasStraight: boolean): void {
    const turn = this.classify(inLanes[0]!, outLanes[0]!);
    const n = inLanes.length, m = outLanes.length;
    if (twoWay) {
      inLanes.forEach((l, i) => this.link(node, l, outLanes[Math.min(i, m - 1)]!, junction, turn));
      return;
    }
    // Lane-use overrides set in the editor (per lane arriving at this node).
    const seg = this.net.segments.get(inLanes[0]!.segment)!;
    const masks = seg.b === node ? seg.turnsB : seg.turnsA;
    const custom = masks?.some((mk, i) => i < n && mk > 0) ?? false;
    const auto = (i: number): boolean => n === 1 || turn === 'straight'
      || (turn === 'left' && i === 0)
      || (turn === 'right' && (hasStraight ? i === n - 1 : i > 0));
    if (!custom) {
      inLanes.forEach((l, i) => {
        if (!auto(i)) return;
        const target = turn === 'left' ? outLanes[0]! : turn === 'right' ? outLanes[m - 1]! : outLanes[Math.min(i, m - 1)]!;
        this.link(node, l, target, junction, turn);
      });
      return;
    }
    const bit = TURN_BIT[turn];
    const allowed = inLanes.filter((_, i) => {
      const mk = masks![i] ?? 0;
      return mk > 0 ? (mk & bit) !== 0 : auto(i);
    });
    const k = allowed.length;
    allowed.forEach((l, j) => {
      // Left turns fill exit lanes from the inside, right turns from the kerb, straight spreads evenly.
      const o = turn === 'left' ? Math.min(j, m - 1)
        : turn === 'right' ? m - 1 - Math.min(k - 1 - j, m - 1)
          : k <= 1 ? 0 : Math.round((j * (m - 1)) / (k - 1));
      this.link(node, l, outLanes[Math.max(0, Math.min(o, m - 1))]!, junction, turn);
    });
  }

  /** Joins two lanes; through junctions a curved connector lane is inserted between them. */
  private link(node: number, a: Lane, b: Lane, junction: boolean, turn: Turn): void {
    if (!junction) {
      a.next.push(b.id);
      b.prev.push(a.id);
      return;
    }
    const n0 = a.path.count;
    const p0 = a.path.point(n0 - 1), p3 = b.path.point(0);
    const d0 = a.path.dirAt(true), d1 = b.path.dirAt(false);
    const k = Math.hypot(p3[0] - p0[0], p3[2] - p0[2]) * 0.38;
    const curve = new CubicBezier(p0, vec3.add(p0, vec3.scale(d0, k)), vec3.sub(p3, vec3.scale(d1, k)), p3);
    const pts: Vec3[] = [];
    for (let i = 0; i <= 12; i++) pts.push(curve.point(curve.tAtDistance((curve.length * i) / 12)));
    const path = new Path(pts);
    // A connector is driven at one speed, from its average radius. (Its Bezier is tighter in the
    // middle than a circular arc of the same sweep; the tightest radius makes turns needlessly slow
    // and drivers then reject gaps they could take.)
    const bend = Math.acos(Math.max(-1, Math.min(1, vec3.dot(d0, d1))));
    const radius = bend > 0.05 ? path.length / bend : Infinity;
    const limit = Math.min(a.speedLimit, b.speedLimit, Math.sqrt(MAX_LAT_ACCEL * radius));
    const c = this.add('connector', -1, node, a.toNode, b.fromNode, a.index, turn, path, limit);
    a.next.push(c.id);
    c.prev.push(a.id);
    c.next.push(b.id);
    b.prev.push(c.id);
  }
}

/**
 * Connects `a` lanes to `b` lanes in order (both counted from the same side) so that every lane
 * on each side gets at least one partner: lane i takes the b-lanes its share of the width covers.
 */
function spread(a: number, b: number, link: (i: number, j: number) => void): void {
  for (let i = 0; i < a; i++) {
    const j0 = Math.floor((i * b) / a), j1 = Math.max(j0, Math.ceil(((i + 1) * b) / a) - 1);
    for (let j = j0; j <= j1; j++) link(i, j);
  }
}

/**
 * Radius of curvature (m) at each path point, from the turn between its neighbouring pieces
 * (Infinity where straight). End points copy their neighbour.
 */
export function pathRadii(path: Path): Float64Array {
  const n = path.count, pts = path.pts;
  const r = new Float64Array(n).fill(Infinity);
  for (let k = 1; k + 1 < n; k++) {
    const ax = pts[k * 3]! - pts[k * 3 - 3]!, az = pts[k * 3 + 2]! - pts[k * 3 - 1]!;
    const bx = pts[k * 3 + 3]! - pts[k * 3]!, bz = pts[k * 3 + 5]! - pts[k * 3 + 2]!;
    const la = Math.hypot(ax, az), lb = Math.hypot(bx, bz);
    if (la < 1e-6 || lb < 1e-6) continue;
    const turn = Math.abs(Math.atan2(ax * bz - az * bx, ax * bx + az * bz));
    if (turn > 1e-4) r[k] = (la + lb) / 2 / turn;
  }
  if (n > 2) {
    r[0] = r[1]!;
    r[n - 1] = r[n - 2]!;
  }
  return r;
}

/** Cornering speed at each point of a path: `sqrt(MAX_LAT_ACCEL · radius)`, at most `limit`. */
export function safeSpeeds(path: Path, limit: number): Float32Array {
  const r = pathRadii(path), n = path.count;
  const out = new Float32Array(n);
  for (let k = 0; k < n; k++) out[k] = Math.min(limit, Math.sqrt(MAX_LAT_ACCEL * r[k]!));
  return out;
}

/** Runs of points noticeably below the limit, as [start s, end s, lowest speed] triples. */
function slowStretches(path: Path, safe: Float32Array, limit: number): Float32Array {
  const out: number[] = [];
  const cum = path.cum, n = safe.length;
  for (let k = 0; k < n; k++) {
    if (safe[k]! >= limit - 0.05) continue;
    const start = k;
    let low = safe[k]!;
    while (k + 1 < n && safe[k + 1]! < limit - 0.05) low = Math.min(low, safe[++k]!);
    out.push(cum[Math.max(0, start - 1)]!, cum[Math.min(n - 1, k + 1)]!, low);
  }
  return new Float32Array(out);
}

/** Safe speed (m/s, speed factor 1) at arc length s along a lane. Allocation-free. */
export function safeSpeedAt(lane: Lane, s: number): number {
  if (!lane.curved) return lane.speedLimit;
  const cum = lane.path.cum, safe = lane.safe, n = cum.length;
  if (s <= 0) return safe[0]!;
  if (s >= cum[n - 1]!) return safe[n - 1]!;
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid]! <= s) lo = mid;
    else hi = mid;
  }
  const seg = cum[hi]! - cum[lo]!;
  const t = seg > 0 ? (s - cum[lo]!) / seg : 0;
  return safe[lo]! + (safe[hi]! - safe[lo]!) * t;
}

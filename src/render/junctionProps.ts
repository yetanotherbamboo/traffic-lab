import type { Vec3 } from '../core/math';
import { KIND_EMISSIVE, KIND_PLAIN, LIT_STRIDE } from '../env/city';
import { rightOf } from '../network/network';
import { type JunctionModel, SIGNAL_GREEN, SIGNAL_RED, type SignalController } from '../sim/junctions';
import { type Lane, type LaneGraph, TURN_BIT } from '../sim/laneGraph';
import type { TrafficSim } from '../sim/traffic';
import { GLOW_STRIDE } from './lights';
import { MAT_PAINT, MAT_PAINT_YELLOW, type MeshData, ROAD_STRIDE } from './roadMesh';


const PAINT: Vec3 = [0.93, 0.92, 0.88];
const POLE: Vec3 = [0.3, 0.32, 0.36];
const STOP_SIGN: Vec3 = [0.84, 0.27, 0.24];
const LAMP: Record<number, Vec3> = { 0: [0.35, 0.92, 0.55], 1: [1.0, 0.76, 0.3], 2: [0.98, 0.32, 0.28] };
const SIDEWALK_Y = 0.18;
/** Turn arrows start this far (m) before the stop line, or nearer on short approaches. */
const ARROW_BACK = 8;
/** Approaches shorter than this get no arrow (it is 3.6 m long and must clear the stop line). */
const ARROW_MIN_LANE = 5.5;
/** Arrow shape (m): stem width, head half-width and length, stem length to the head. */
const ARROW_STEM = 0.26;
const ARROW_HEAD_HALF = 0.4;
const ARROW_HEAD_LEN = 1.05;
const ARROW_LEN = 3.6;
/** Turn branches leave the stem here and end (where their head starts) this far ahead and aside. */
const BRANCH_FROM = 1.0;
const BRANCH_END_F = 2.3;
const BRANCH_END_U = 0.5;
const BRANCH_HEAD_LEN = 0.62;
const BRANCH_HEAD_HALF = 0.34;
/** Painted shapes lie flat just above the asphalt (which is lifted 0.03 m). */
const PAINT_Y = 0.04;
const scratch = new Float32Array(4);
const ROAD_Y = 0.03;

/** Height of the lit lamp's box above the signal head's base (red top, green bottom). */
const lampHeight = (st: number): number => (st === SIGNAL_RED ? 0.82 : st === SIGNAL_GREEN ? 0.12 : 0.47);

interface Lamp {
  ctrl: SignalController;
  connector: number;
  x: number;
  z: number;
  heading: number;
  dir: Vec3;
}

/** The path a non-stop lane's markings follow through the junction: straight on, or its only path. */
function mainPath(graph: LaneGraph, l: Lane): Lane | null {
  const conns = l.next.map((c) => graph.lanes[c]!);
  return conns.find((c) => c.turn === 'straight') ?? (conns.length === 1 ? conns[0]! : null);
}

/** Flat painted shapes on the road (road vertex layout, `MAT_PAINT`), facing up. */
class PaintBuilder {
  readonly v: number[] = [];
  readonly i: number[] = [];

  private vertex(p: Vec3, mat: number): number {
    this.v.push(p[0], p[1], p[2], 0, 1, 0, 0, 0, 0, 0, 0, mat);
    return this.v.length / ROAD_STRIDE - 1;
  }

  /** One triangle, wound to face up whatever order the corners come in. */
  tri(a: Vec3, b: Vec3, c: Vec3, mat = MAT_PAINT): void {
    const up = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]); // y of (b-a)×(c-a)
    const [ia, ib, ic] = [this.vertex(a, mat), this.vertex(b, mat), this.vertex(c, mat)];
    if (up >= 0) this.i.push(ia, ib, ic);
    else this.i.push(ia, ic, ib);
  }

  quad(a: Vec3, b: Vec3, c: Vec3, d: Vec3, mat = MAT_PAINT): void {
    this.tri(a, b, c, mat);
    this.tri(a, c, d, mat);
  }

  build(): MeshData {
    return { vertices: new Float32Array(this.v), indices: new Uint32Array(this.i) };
  }
}

/**
 * A lane arrow as solid paint, the way road arrows look: a straight bar with a broad triangular
 * head, and turn branches that curve smoothly off the bar into their own head. `at(f, u)` maps
 * arrow coordinates (f metres forward from its base, u metres right of the lane centre) to the
 * road, following the lane's path.
 */
function arrowShape(at: (f: number, u: number) => Vec3, turns: Set<string>, out: PaintBuilder): void {
  const w = ARROW_STEM / 2;
  const straight = turns.has('straight');
  const stemEnd = straight ? ARROW_LEN - ARROW_HEAD_LEN + 0.05 : BRANCH_FROM + 0.3;
  // Stem, in short pieces so it bends with curved lanes.
  const n = Math.max(2, Math.ceil(stemEnd / 0.6));
  for (let k = 0; k < n; k++) {
    const f0 = (stemEnd * k) / n, f1 = (stemEnd * (k + 1)) / n;
    out.quad(at(f0, -w), at(f0, w), at(f1, w), at(f1, -w));
  }
  if (straight) {
    const hb = ARROW_LEN - ARROW_HEAD_LEN;
    out.tri(at(hb, -ARROW_HEAD_HALF), at(hb, ARROW_HEAD_HALF), at(ARROW_LEN, 0));
  }
  for (const [t, sgn] of [['left', -1], ['right', 1]] as const) {
    if (!turns.has(t)) continue;
    // Quadratic curve (in f, u) from the stem out to the side, drawn as a band of stem width.
    const P0 = [BRANCH_FROM, 0], P1 = [BRANCH_END_F - 0.35, 0], P2 = [BRANCH_END_F, sgn * BRANCH_END_U];
    const point = (s: number): [number, number] => {
      const a = (1 - s) * (1 - s), b = 2 * s * (1 - s), c = s * s;
      return [a * P0[0]! + b * P1[0]! + c * P2[0]!, a * P0[1]! + b * P1[1]! + c * P2[1]!];
    };
    const tangent = (s: number): [number, number] => {
      const x = 2 * (1 - s) * (P1[0]! - P0[0]!) + 2 * s * (P2[0]! - P1[0]!);
      const y = 2 * (1 - s) * (P1[1]! - P0[1]!) + 2 * s * (P2[1]! - P1[1]!);
      const l = Math.hypot(x, y) || 1;
      return [x / l, y / l];
    };
    const steps = 8;
    let prevL: Vec3 | null = null, prevR: Vec3 | null = null;
    for (let k = 0; k <= steps; k++) {
      const s = k / steps;
      const [f, u] = point(s), [df, du] = tangent(s);
      // Normal to the curve (left/right of its direction) in (f, u).
      const L = at(f + du * w, u - df * w), R = at(f - du * w, u + df * w);
      if (prevL && prevR) out.quad(prevL, prevR, R, L);
      prevL = L;
      prevR = R;
    }
    // Head along the branch's end direction.
    const [ef, eu] = point(1), [df, du] = tangent(1);
    const bf = ef - df * 0.05, bu = eu - du * 0.05;
    out.tri(
      at(bf + du * BRANCH_HEAD_HALF, bu - df * BRANCH_HEAD_HALF),
      at(bf - du * BRANCH_HEAD_HALF, bu + df * BRANCH_HEAD_HALF),
      at(ef + df * BRANCH_HEAD_LEN, eu + du * BRANCH_HEAD_LEN),
    );
  }
}

/**
 * Junction furniture drawn with the box kit: stop / give-way lines, traffic-light poles and heads,
 * stop signs, plus signal lamps whose colour and position follow the live signal state.
 */
export class JunctionProps {
  private readonly fixed: Float32Array;
  private readonly lamps: Lamp[] = [];
  readonly buffer: Float32Array;
  /** Approach lanes that got turn arrows (for tests). */
  arrowLanes = 0;
  /** Lane arrows: flat painted shapes in the road vertex layout. */
  readonly paint: MeshData;

  constructor(sim: TrafficSim) {
    const { junctions, graph } = sim;
    const out: number[] = [];
    const paint = new PaintBuilder();
    const box = (p: Vec3, heading: number, scale: Vec3, color: Vec3): void => {
      out.push(p[0], p[1], p[2], heading, scale[0], scale[1], scale[2], color[0], color[1], color[2], KIND_PLAIN);
    };

    for (const [nodeId, control] of junctions.control) {
      const incoming = junctions.incoming.get(nodeId) ?? [];
      const major = junctions.major.get(nodeId);
      const arms = new Map<number, number[]>();
      for (const id of incoming) {
        const seg = graph.lanes[id]!.segment;
        arms.set(seg, [...(arms.get(seg) ?? []), id]);
      }
      for (const [seg, laneIds] of arms) {
        const minor = control === 'priority' && !major?.has(seg);
        const lines = control !== 'priority' || minor;

        // Lines across every incoming lane: solid stop line, or dashed give-way line. Non-stop lanes
        // get none; their markings continue through the junction instead.
        for (const id of lines ? laneIds : []) {
          const l = graph.lanes[id]!;
          if (junctions.free[id]) continue;
          const end = l.path.point(l.path.count - 1), dir = l.path.dirAt(true), r = rightOf(dir);
          const h = Math.atan2(-dir[2], dir[0]);
          const c: Vec3 = [end[0] - dir[0] * 0.5, ROAD_Y, end[2] - dir[2] * 0.5];
          if (!minor) {
            box(c, h, [0.4, 0.02, l.width - 0.4], PAINT);
          } else {
            for (let k = 0; k < 4; k++) {
              const u = ((k + 0.5) / 4 - 0.5) * (l.width - 0.4);
              box([c[0] + r[0] * u, ROAD_Y, c[2] + r[2] * u], h, [0.35, 0.02, 0.45], PAINT);
            }
          }
        }
        // Turn arrows on approach lanes of a real junction (3+ roads), but only where the lane is
        // limited to some directions: no arrow means every way the junction offers. They follow
        // the lane's path so they stay in the lane on curved approaches; short approaches (close
        // junctions) get the arrow nearer the stop line.
        if (graph.net.node(nodeId).segments.length >= 3 && graph.net.node(nodeId).ring === undefined) {
          for (const id of laneIds) {
            const l = graph.lanes[id]!;
            if (l.path.length < ARROW_MIN_LANE) continue;
            const turns = new Set(l.next.map((n) => graph.lanes[n]!.turn ?? 'straight'));
            // No arrow means "any direction": skip lanes that may take every turn the arm offers.
            let mask = 0;
            for (const t of turns) mask |= TURN_BIT[t];
            if (mask === graph.armTurns.get(id)) continue;
            this.arrowLanes++;
            const D = Math.min(ARROW_BACK, l.path.length - 0.3);
            // Point `f` metres along the arrow (from its base) and `u` metres right of the lane centre.
            const at = (f: number, u: number): Vec3 => {
              l.path.sample(l.path.length - D + f, scratch);
              const h = scratch[3]!, rx = Math.sin(h), rz = Math.cos(h); // right of (cos h, -sin h)
              return [scratch[0]! + rx * u, PAINT_Y, scratch[2]! + rz * u];
            };
            arrowShape(at, turns, paint);
          }
        }
        for (const id of laneIds) if (junctions.free[id]) this.nonStopLines(graph, junctions, id, paint);
        const stopping = laneIds.filter((id) => !junctions.free[id]);
        if (!lines || minor || stopping.length === 0) continue;

        // Pole on the kerb next to the outermost lane that stops.
        const kerb = stopping.map((id) => graph.lanes[id]!).reduce((a, b) => (b.index > a.index ? b : a));
        const end = kerb.path.point(kerb.path.count - 1), dir = kerb.path.dirAt(true), r = rightOf(dir);
        const h = Math.atan2(-dir[2], dir[0]);
        const off = kerb.width / 2 + 1.5;
        const x = end[0] + r[0] * off - dir[0] * 0.8, z = end[2] + r[2] * off - dir[2] * 0.8;
        if (control === 'signal') {
          box([x, SIDEWALK_Y, z], h, [0.16, 3.6, 0.16], POLE);
          box([x, SIDEWALK_Y + 2.5, z], h, [0.36, 1.1, 0.42], POLE);
          const ctrl = junctions.signals.get(nodeId)!;
          const connector = graph.lanes[kerb.id]!.next[0]!;
          this.lamps.push({ ctrl, connector, x, z, heading: h, dir });
        } else {
          box([x, SIDEWALK_Y, z], h, [0.1, 2.4, 0.1], POLE);
          box([x - dir[0] * 0.08, SIDEWALK_Y + 1.85, z - dir[2] * 0.08], h, [0.06, 0.75, 0.75], STOP_SIGN);
        }
      }
    }
    this.paint = paint.build();
    this.fixed = new Float32Array(out);
    this.buffer = new Float32Array(this.fixed.length + this.lamps.length * LIT_STRIDE);
    this.buffer.set(this.fixed);
  }

  /**
   * Markings of a non-stop lane, continued through the junction along its straight-on path (or
   * its only path): the centre line or a solid line wherever it runs next to lanes that stop, a
   * dashed divider next to another non-stop lane, and the road's edge line on a side no movement
   * of the lane turns off to.
   */
  private nonStopLines(graph: LaneGraph, junctions: JunctionModel, id: number, paint: PaintBuilder): void {
    const l = graph.lanes[id]!;
    const conns = l.next.map((c) => graph.lanes[c]!);
    const C = mainPath(graph, l);
    if (!C) return;
    const group = graph.groups[l.group]!;
    const seg = graph.net.segment(l.segment);
    const twoWay = seg.profile.forward > 0 && seg.profile.backward > 0;
    const hw = l.width / 2;
    const turns = new Set(conns.map((c) => c.turn));
    const freeLane = (k: number): boolean => {
      const n = group.find((g) => graph.lanes[g]!.index === k);
      return n !== undefined && junctions.free[n] === 1;
    };
    // Flat paint in the road shader's paint materials, so these lines look exactly like the
    // road's own markings they continue (same colours, blend and lighting).
    const line = (u: number, w: number, mat: number, dashed: boolean): void => {
      const path = C.path, len = path.length;
      const n = Math.max(1, Math.ceil(len / 1.5));
      let prev: [Vec3, Vec3] | null = null;
      for (let k = 0; k <= n; k++) {
        const s = (len * k) / n;
        path.sample(s, scratch);
        const h = scratch[3]!, sx = Math.sin(h), cz = Math.cos(h); // (sx, cz): sideways, to the right
        const at = (o: number): Vec3 => [scratch[0]! + sx * o, PAINT_Y, scratch[2]! + cz * o];
        const edge: [Vec3, Vec3] = [at(u - w / 2), at(u + w / 2)];
        if (prev && (!dashed || ((s - len / (2 * n)) / 9) % 1 < 0.34)) paint.quad(prev[0], prev[1], edge[1], edge[0], mat);
        prev = edge;
      }
    };
    // Left side.
    if (l.index === 0) {
      if (twoWay) {
        // Nothing crosses a non-stop lane, so the centre line beside it is a full double line.
        // Its far half belongs to the oncoming lane alongside: drawn here unless that lane is
        // non-stop too and draws its own (both halves would land on the same spot).
        line(-hw + 0.14, 0.12, MAT_PAINT_YELLOW, false);
        const exitSeg = graph.lanes[C.next[0]!]!.segment;
        const partner = graph.lanes.find((o) => o.kind === 'road' && o.segment === exitSeg && o.toNode === l.toNode && o.index === 0);
        const drawsOwn = partner !== undefined && junctions.free[partner.id] === 1 && mainPath(graph, partner) !== null;
        if (!drawsOwn) line(-hw - 0.14, 0.12, MAT_PAINT_YELLOW, false);
      }
      else if (!turns.has('left')) line(-hw + 0.35, 0.16, MAT_PAINT, false);
    } else if (!freeLane(l.index - 1)) {
      line(-hw, 0.14, MAT_PAINT, false);
    }
    // Right side (the divider between two non-stop lanes is drawn by the inner one).
    if (l.index === group.length - 1) {
      if (!turns.has('right')) line(hw - 0.35, 0.16, MAT_PAINT, false);
    } else {
      line(hw, 0.14, MAT_PAINT, freeLane(l.index + 1));
    }
  }

  /**
   * Writes a glow sprite (GLOW_STRIDE floats) for every lit lamp into `out` starting at sprite
   * `start`, so signals stay readable when zoomed out. Returns the number written.
   */
  writeGlows(out: Float32Array, start: number): number {
    let o = start * GLOW_STRIDE;
    for (const l of this.lamps) {
      const st = l.ctrl.state(l.connector);
      const c = LAMP[st]!;
      out[o] = l.x - l.dir[0] * 0.3;
      out[o + 1] = SIDEWALK_Y + 2.5 + lampHeight(st) + 0.13;
      out[o + 2] = l.z - l.dir[2] * 0.3;
      out[o + 3] = 1.3; // world size (m)
      out[o + 4] = c[0] * 1.1; out[o + 5] = c[1] * 1.1; out[o + 6] = c[2] * 1.1;
      out[o + 7] = 0.03; // at least ~1.7° on screen: readable when zoomed out
      o += GLOW_STRIDE;
    }
    return this.lamps.length;
  }

  get lampCount(): number {
    return this.lamps.length;
  }

  /** Updates lamp instances in `buffer` for the current signal states; returns the instance count. */
  update(): number {
    let o = this.fixed.length;
    for (const l of this.lamps) {
      const st = l.ctrl.state(l.connector);
      const c = LAMP[st]!;
      const y = SIDEWALK_Y + 2.5 + lampHeight(st);
      const b = this.buffer;
      b[o] = l.x - l.dir[0] * 0.22;
      b[o + 1] = y;
      b[o + 2] = l.z - l.dir[2] * 0.22;
      b[o + 3] = l.heading;
      b[o + 4] = 0.1; b[o + 5] = 0.26; b[o + 6] = 0.3;
      b[o + 7] = c[0]; b[o + 8] = c[1]; b[o + 9] = c[2];
      b[o + 10] = KIND_EMISSIVE;
      o += LIT_STRIDE;
    }
    return this.buffer.length / LIT_STRIDE;
  }
}

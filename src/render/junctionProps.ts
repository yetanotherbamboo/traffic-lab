import type { Vec3 } from '../core/math';
import { KIND_EMISSIVE, KIND_PLAIN, LIT_STRIDE } from '../env/city';
import { rightOf } from '../network/network';
import { SIGNAL_GREEN, SIGNAL_RED, type SignalController } from '../sim/junctions';
import type { TrafficSim } from '../sim/traffic';
import { GLOW_STRIDE } from './lights';


const PAINT: Vec3 = [0.93, 0.92, 0.88];
const POLE: Vec3 = [0.3, 0.32, 0.36];
const STOP_SIGN: Vec3 = [0.84, 0.27, 0.24];
const LAMP: Record<number, Vec3> = { 0: [0.35, 0.92, 0.55], 1: [1.0, 0.76, 0.3], 2: [0.98, 0.32, 0.28] };
const SIDEWALK_Y = 0.18;
/** Turn arrows start this far (m) before the stop line, or nearer on short approaches. */
const ARROW_BACK = 8;
/** Approaches shorter than this get no arrow (it is 3.6 m long and must clear the stop line). */
const ARROW_MIN_LANE = 5.5;
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

  constructor(sim: TrafficSim) {
    const { junctions, graph } = sim;
    const out: number[] = [];
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

        // Lines across every incoming lane: solid stop line, or dashed give-way line.
        for (const id of lines ? laneIds : []) {
          const l = graph.lanes[id]!;
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
        // Turn arrows painted on every approach lane of a real junction (3+ roads), following the
        // lane's own path so they stay in the lane on curved approaches. Short approaches (close
        // junctions) get the arrow nearer the stop line.
        if (graph.net.node(nodeId).segments.length >= 3) {
          for (const id of laneIds) {
            const l = graph.lanes[id]!;
            if (l.path.length < ARROW_MIN_LANE) continue;
            this.arrowLanes++;
            const turns = new Set(l.next.map((n) => graph.lanes[n]!.turn ?? 'straight'));
            const D = Math.min(ARROW_BACK, l.path.length - 0.3);
            // Point `f` metres along the arrow (from its base) and `u` metres right of the lane centre.
            const at = (f: number, u: number): Vec3 => {
              l.path.sample(l.path.length - D + f, scratch);
              const h = scratch[3]!, rx = Math.sin(h), rz = Math.cos(h); // right of (cos h, -sin h)
              return [scratch[0]! + rx * u, ROAD_Y, scratch[2]! + rz * u];
            };
            const seg = (a: Vec3, b: Vec3, w: number): void => {
              const dx = b[0] - a[0], dz = b[2] - a[2];
              box([(a[0] + b[0]) / 2, ROAD_Y, (a[2] + b[2]) / 2], Math.atan2(-dz, dx), [Math.hypot(dx, dz) + w * 0.5, 0.02, w], PAINT);
            };
            const head = (tip: Vec3, from: Vec3): void => {
              const dx = tip[0] - from[0], dz = tip[2] - from[2], len = Math.hypot(dx, dz) || 1;
              const ux = dx / len, uz = dz / len;
              for (const sgn of [1, -1]) {
                const c = Math.cos(0.6), sn = Math.sin(0.6) * sgn;
                const bx = -(ux * c - uz * sn), bz = -(uz * c + ux * sn); // rotated back-pointing
                seg(tip, [tip[0] + bx * 0.75, 0, tip[2] + bz * 0.75], 0.16);
              }
            };
            const base = at(0, 0), fork = at(1.8, 0);
            seg(base, fork, 0.18);
            if (turns.has('straight')) {
              const tip = at(3.6, 0);
              seg(fork, tip, 0.18);
              head(tip, fork);
            }
            for (const [t, u] of [['left', -1], ['right', 1]] as const) {
              if (!turns.has(t)) continue;
              const tip = at(2.9, u * 1.0);
              seg(fork, tip, 0.18);
              head(tip, fork);
            }
          }
        }
        if (!lines || minor) continue;

        // Pole on the kerb next to the outermost lane.
        const kerb = laneIds.map((id) => graph.lanes[id]!).reduce((a, b) => (b.index > a.index ? b : a));
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
    this.fixed = new Float32Array(out);
    this.buffer = new Float32Array(this.fixed.length + this.lamps.length * LIT_STRIDE);
    this.buffer.set(this.fixed);
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

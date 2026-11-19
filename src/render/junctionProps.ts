import type { Vec3 } from '../core/math';
import { KIND_PLAIN, LIT_STRIDE } from '../env/city';
import { rightOf } from '../network/network';
import { SIGNAL_GREEN, SIGNAL_RED, type SignalController } from '../sim/junctions';
import type { TrafficSim } from '../sim/traffic';

/** Instance kind: unlit, self-coloured (signal lamps). Keep in sync with litFS. */
export const KIND_EMISSIVE = 3;

const PAINT: Vec3 = [0.93, 0.92, 0.88];
const POLE: Vec3 = [0.3, 0.32, 0.36];
const STOP_SIGN: Vec3 = [0.84, 0.27, 0.24];
const LAMP: Record<number, Vec3> = { 0: [0.35, 0.92, 0.55], 1: [1.0, 0.76, 0.3], 2: [0.98, 0.32, 0.28] };
const SIDEWALK_Y = 0.18;
const ROAD_Y = 0.03;

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
        if (control === 'priority' && !minor) continue;

        // Lines across every incoming lane: solid stop line, or dashed give-way line.
        for (const id of laneIds) {
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
        if (minor) continue;

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

  /** Updates lamp instances in `buffer` for the current signal states; returns the instance count. */
  update(): number {
    let o = this.fixed.length;
    for (const l of this.lamps) {
      const st = l.ctrl.state(l.connector);
      const c = LAMP[st]!;
      const y = SIDEWALK_Y + 2.5 + (st === SIGNAL_RED ? 0.82 : st === SIGNAL_GREEN ? 0.12 : 0.47);
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

import { KIND_EMISSIVE, LIT_STRIDE } from '../env/city';
import { POSE_STRIDE, type TrafficSim } from '../sim/traffic';

/** Floats per glow sprite: centre(3) + size(1) + colour × intensity(3) + min angular size(1). */
export const GLOW_STRIDE = 8;

/** Vehicles start indicating this far (m) before a turn. */
const SIGNAL_AHEAD = 45;
const BLINK_HZ = 1.5;
const AMBER: [number, number, number] = [1.0, 0.62, 0.12];

/**
 * Which way vehicle i is indicating: -1 left, +1 right, 0 none. Turning at the next junction
 * (within SIGNAL_AHEAD), driving through a turn, or changing lanes.
 */
export function blinkerSide(sim: TrafficSim, i: number): number {
  const W = sim.lcW[i]!;
  if (W !== 0) return W > 0 ? -1 : 1; // offset to the right of the new lane = moving left
  const lanes = sim.graph.lanes;
  const lane = lanes[sim.lane[i]!]!;
  let turn = lane.turn;
  if (lane.kind === 'road') {
    if (lane.path.length - sim.s[i]! > SIGNAL_AHEAD) return 0;
    const nx = sim.table(sim.dest[i]!).next[lane.id]!;
    turn = nx >= 0 ? lanes[nx]!.turn : null;
  }
  return turn === 'left' ? -1 : turn === 'right' ? 1 : 0;
}

/** Interpolated pose scratch: x, z, heading. */
const pose = new Float64Array(3);

function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a;
  if (d > Math.PI) d -= Math.PI * 2;
  else if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

export interface LightCounts {
  boxes: number;
  glows: number;
}

/**
 * Blinkers: for every indicating vehicle whose blinker is in its "on" half-period, a small amber
 * self-lit box at the front and rear corner of that side (into `boxes`, LIT_STRIDE) and a glow
 * sprite for each (into `glows` from sprite `glowStart`). Allocation-free; returns counts in `out`.
 */
export function writeVehicleLights(
  sim: TrafficSim, alpha: number, time: number,
  boxes: Float32Array, glows: Float32Array, glowStart: number, out: LightCounts,
): LightCounts {
  const { prevPose: p0, pose: p1 } = sim;
  let nb = 0, ng = glowStart;
  for (let i = 0; i < sim.capacity; i++) {
    if (!sim.alive[i]) continue;
    const side = blinkerSide(sim, i);
    if (side === 0) continue;
    // Each car blinks at its own phase.
    if ((time * BLINK_HZ + i * 0.137) % 1 > 0.55) continue;
    const k = i * POSE_STRIDE;
    pose[0] = p0[k]! + (p1[k]! - p0[k]!) * alpha;
    pose[1] = p0[k + 2]! + (p1[k + 2]! - p0[k + 2]!) * alpha;
    pose[2] = lerpAngle(p0[k + 3]!, p1[k + 3]!, alpha);
    const h = pose[2]!;
    const fx = Math.cos(h), fz = -Math.sin(h); // forward
    const rx = -fz, rz = fx; // right
    const len = sim.length[i]!, half = sim.width[i]! / 2;
    const y = sim.height[i]! * 0.28;
    const lat = side * (half - 0.12);
    for (let end = 0; end < 2; end++) {
      // end 0 = front corner, 1 = rear corner; `out` points away from the car along its axis.
      const back = end === 0 ? 0.04 : len - 0.04, outDir = end === 0 ? 1 : -1;
      const x = pose[0]! - fx * back + rx * lat, z = pose[1]! - fz * back + rz * lat;
      const o = nb * LIT_STRIDE;
      boxes[o] = x; boxes[o + 1] = y; boxes[o + 2] = z; boxes[o + 3] = h;
      boxes[o + 4] = 0.16; boxes[o + 5] = 0.13; boxes[o + 6] = 0.26;
      boxes[o + 7] = AMBER[0]; boxes[o + 8] = AMBER[1]; boxes[o + 9] = AMBER[2];
      boxes[o + 10] = KIND_EMISSIVE;
      nb++;
      const g = ng * GLOW_STRIDE;
      // Glow sits just outside the body, at the lamp.
      const gx = x + fx * outDir * 0.15 + rx * side * 0.1, gz = z + fz * outDir * 0.15 + rz * side * 0.1;
      glows[g] = gx; glows[g + 1] = y + 0.07; glows[g + 2] = gz; glows[g + 3] = 0.9;
      glows[g + 4] = AMBER[0] * 0.9; glows[g + 5] = AMBER[1] * 0.9; glows[g + 6] = AMBER[2] * 0.9;
      glows[g + 7] = 0.009;
      ng++;
    }
  }
  out.boxes = nb;
  out.glows = ng - glowStart;
  return out;
}

import { KIND_VAN, KIND_VEHICLE, LIT_STRIDE } from '../env/city';
import { PALETTE } from '../env/style';
import { POSE_STRIDE, type TrafficSim } from '../sim/traffic';

const rear = new Float32Array(4);

function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a;
  if (d > Math.PI) d -= Math.PI * 2;
  else if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

export interface VehicleCounts {
  cars: number;
  vans: number;
}

/**
 * Writes one lit instance per live vehicle, cars into `cars` and vans into `vans` (each drawn
 * with its own model), interpolating between the last two simulation steps by `alpha`.
 * Allocation-free; returns the counts in `out`.
 */
export function writeVehicleInstances(
  sim: TrafficSim, alpha: number, cars: Float32Array, vans: Float32Array, out: VehicleCounts,
): VehicleCounts {
  const { prevPose: p0, pose: p1 } = sim;
  const colors = PALETTE.vehicles;
  let nc = 0, nv = 0;
  for (let i = 0; i < sim.capacity; i++) {
    if (!sim.alive[i]) continue;
    const van = sim.van[i] === 1;
    const k = i * POSE_STRIDE, o = (van ? nv++ : nc++) * LIT_STRIDE;
    const d = van ? vans : cars;
    const c = colors[sim.color[i]! % colors.length]!;
    // Poses are front-bumper points; the car mesh is centred, so step back half a length.
    const h = lerpAngle(p0[k + 3]!, p1[k + 3]!, alpha);
    const half = sim.length[i]! / 2;
    d[o] = p0[k]! + (p1[k]! - p0[k]!) * alpha - Math.cos(h) * half;
    // On a ramp the body sits between its front and rear heights (the model doesn't tilt).
    const lane = sim.graph.lanes[sim.lane[i]!]!;
    lane.path.sample(sim.s[i]! - sim.length[i]!, rear);
    const front = p0[k + 1]! + (p1[k + 1]! - p0[k + 1]!) * alpha;
    d[o + 1] = front + (rear[1]! - p1[k + 1]!) / 2;
    d[o + 2] = p0[k + 2]! + (p1[k + 2]! - p0[k + 2]!) * alpha + Math.sin(h) * half;
    d[o + 3] = h;
    d[o + 4] = sim.length[i]!;
    d[o + 5] = sim.height[i]!;
    d[o + 6] = sim.width[i]!;
    d[o + 7] = c[0];
    d[o + 8] = c[1];
    d[o + 9] = c[2];
    d[o + 10] = van ? KIND_VAN : KIND_VEHICLE;
  }
  out.cars = nc;
  out.vans = nv;
  return out;
}

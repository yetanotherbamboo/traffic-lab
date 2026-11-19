import { KIND_VEHICLE, LIT_STRIDE } from '../env/city';
import { PALETTE } from '../env/style';
import { POSE_STRIDE, type TrafficSim } from '../sim/traffic';

function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a;
  if (d > Math.PI) d -= Math.PI * 2;
  else if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

/**
 * Writes one lit instance per live vehicle into `out`, interpolating between the last two
 * simulation steps by `alpha`. Returns the instance count. Allocation-free.
 */
export function writeVehicleInstances(sim: TrafficSim, alpha: number, out: Float32Array): number {
  const { prevPose: p0, pose: p1 } = sim;
  const colors = PALETTE.vehicles;
  let n = 0;
  for (let i = 0; i < sim.capacity; i++) {
    if (!sim.alive[i]) continue;
    const k = i * POSE_STRIDE, o = n * LIT_STRIDE;
    const c = colors[sim.color[i]! % colors.length]!;
    // Poses are front-bumper points; the car mesh is centred, so step back half a length.
    const h = lerpAngle(p0[k + 3]!, p1[k + 3]!, alpha);
    const half = sim.length[i]! / 2;
    out[o] = p0[k]! + (p1[k]! - p0[k]!) * alpha - Math.cos(h) * half;
    out[o + 1] = p0[k + 1]! + (p1[k + 1]! - p0[k + 1]!) * alpha;
    out[o + 2] = p0[k + 2]! + (p1[k + 2]! - p0[k + 2]!) * alpha + Math.sin(h) * half;
    out[o + 3] = h;
    out[o + 4] = sim.length[i]!;
    out[o + 5] = sim.height[i]!;
    out[o + 6] = sim.width[i]!;
    out[o + 7] = c[0];
    out[o + 8] = c[1];
    out[o + 9] = c[2];
    out[o + 10] = KIND_VEHICLE;
    n++;
  }
  return n;
}

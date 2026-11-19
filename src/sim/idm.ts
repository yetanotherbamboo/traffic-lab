/**
 * Intelligent Driver Model (Treiber, Hennecke & Helbing, 2000).
 *
 *   a = aMax · [ 1 − (v/v0)^δ − (sStar / s)² ],   sStar = s0 + max(0, v·T + v·Δv / (2·√(aMax·b)))
 *
 * v: speed, v0: desired speed, s: gap to the leader's rear bumper, Δv = v − v_leader.
 */
export interface DriverParams {
  /** Desired time headway (s). */
  T: number;
  /** Maximum acceleration (m/s²). */
  aMax: number;
  /** Comfortable deceleration (m/s², positive). */
  b: number;
  /** Minimum standstill gap (m). */
  s0: number;
}

export const MAX_BRAKE = 9; // physical limit, m/s²
const DELTA = 4;

/** Acceleration for a follower. Pass gap = Infinity for a free road. */
export function idmAccel(v: number, v0: number, gap: number, dv: number, p: DriverParams): number {
  const free = 1 - Math.pow(v / Math.max(v0, 0.1), DELTA);
  if (gap === Infinity) return p.aMax * free;
  const sStar = p.s0 + Math.max(0, v * p.T + (v * dv) / (2 * Math.sqrt(p.aMax * p.b)));
  const a = p.aMax * (free - (sStar / Math.max(gap, 0.01)) ** 2);
  return Math.max(a, -MAX_BRAKE);
}

/** Highest speed from which a driver can still slow to `vTarget` within `dist` at comfortable deceleration. */
export function approachSpeed(vTarget: number, dist: number, b: number): number {
  return Math.sqrt(vTarget * vTarget + 2 * b * Math.max(dist, 0));
}

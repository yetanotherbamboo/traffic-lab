import { Rng } from '../core/rng';
import { type DriverParams, approachSpeed, idmAccel } from './idm';
import type { LaneGraph } from './laneGraph';
import { findRoute } from './router';

/** Floats per pose: x, y, z, heading. */
export const POSE_STRIDE = 4;
const LOOKAHEAD = 150; // metres scanned ahead along the route for a leader
const SPAWN_CLEARANCE = 8; // free metres needed at a lane start to insert a vehicle

export interface Spawner {
  node: number;
  /** Vehicles per hour entering here; also used as this exit's attractiveness as a destination. */
  rate: number;
}

export interface SimStats {
  vehicles: number;
  spawned: number;
  exited: number;
  meanSpeed: number; // m/s
}

/**
 * Microscopic traffic simulation: vehicles follow lane-level routes and use IDM car-following.
 * State is structure-of-arrays with a fixed capacity; the step is deterministic for a given seed.
 *
 * v1 limitations: no junction conflict handling, signals or lane changes (Milestone 4).
 */
export class TrafficSim {
  readonly alive: Uint8Array;
  readonly lane: Int32Array;
  readonly route: Int32Array; // index into `routes`
  readonly routeIdx: Int32Array;
  readonly s: Float32Array; // distance along current lane
  readonly v: Float32Array;
  readonly acc: Float32Array;
  readonly length: Float32Array;
  readonly width: Float32Array;
  readonly height: Float32Array;
  readonly speedFactor: Float32Array; // desired speed = limit × factor
  readonly T: Float32Array;
  readonly aMax: Float32Array;
  readonly b: Float32Array;
  readonly s0: Float32Array;
  readonly color: Uint8Array;
  /** Poses at the previous and current step, for render interpolation. */
  readonly prevPose: Float32Array;
  readonly pose: Float32Array;

  readonly routes: Int32Array[] = [];
  private readonly routeCache = new Map<string, number>(); // "from>to" → route index (-1 = unreachable)
  private readonly destCache = new Map<number, { route: number; weight: number }[]>();
  private readonly freeSlots: number[] = [];
  private readonly laneVehicles: number[][];
  private readonly rng: Rng;
  private readonly spawners: (Spawner & { pending: number })[];
  private readonly params: DriverParams = { T: 1.4, aMax: 1.5, b: 2, s0: 2 };

  time = 0;
  readonly stats: SimStats = { vehicles: 0, spawned: 0, exited: 0, meanSpeed: 0 };

  constructor(readonly graph: LaneGraph, spawners: Spawner[], seed: number, readonly capacity = 2048) {
    const f32 = (): Float32Array => new Float32Array(capacity);
    this.alive = new Uint8Array(capacity);
    this.lane = new Int32Array(capacity);
    this.route = new Int32Array(capacity);
    this.routeIdx = new Int32Array(capacity);
    this.s = f32(); this.v = f32(); this.acc = f32();
    this.length = f32(); this.width = f32(); this.height = f32();
    this.speedFactor = f32(); this.T = f32(); this.aMax = f32(); this.b = f32(); this.s0 = f32();
    this.color = new Uint8Array(capacity);
    this.prevPose = new Float32Array(capacity * POSE_STRIDE);
    this.pose = new Float32Array(capacity * POSE_STRIDE);
    for (let i = capacity - 1; i >= 0; i--) this.freeSlots.push(i);
    this.laneVehicles = graph.lanes.map(() => []);
    this.rng = new Rng(seed);
    this.spawners = spawners
      .filter((sp) => graph.sources.has(sp.node) || graph.sinks.has(sp.node))
      .map((sp) => ({ ...sp, pending: 0 }));
  }

  /** Cached lane route between two boundary nodes, or -1 if there is none. */
  routeBetween(from: number, to: number): number {
    const key = `${from}>${to}`;
    let id = this.routeCache.get(key);
    if (id === undefined) {
      const src = this.graph.sources.get(from), dst = this.graph.sinks.get(to);
      const r = src && dst ? findRoute(this.graph, src, dst) : null;
      id = r ? this.routes.push(r) - 1 : -1;
      this.routeCache.set(key, id);
    }
    return id;
  }

  /** Inserts a vehicle at the start of a route if there is room. Returns the slot or -1. */
  spawn(routeId: number, opts: Partial<{ speedFactor: number; length: number }> = {}): number {
    const r = this.routes[routeId];
    if (!r || this.freeSlots.length === 0) return -1;
    const lane = r[0]!;
    const occupants = this.laneVehicles[lane]!;
    let entrySpeed = Infinity;
    for (const j of occupants) {
      if (this.s[j]! - this.length[j]! < SPAWN_CLEARANCE) return -1;
      entrySpeed = Math.min(entrySpeed, this.v[j]!);
    }
    const i = this.freeSlots.pop()!;
    const rng = this.rng;
    const van = rng.chance(0.1);
    this.alive[i] = 1;
    this.lane[i] = lane;
    this.route[i] = routeId;
    this.routeIdx[i] = 0;
    this.s[i] = 0;
    this.length[i] = opts.length ?? (van ? rng.range(5.2, 6) : rng.range(4, 4.8));
    this.width[i] = van ? 2.0 : rng.range(1.75, 1.9);
    this.height[i] = van ? rng.range(2.1, 2.4) : rng.range(1.4, 1.6);
    this.speedFactor[i] = opts.speedFactor ?? rng.range(0.9, 1.08);
    this.T[i] = this.params.T * rng.range(0.85, 1.2);
    this.aMax[i] = this.params.aMax * rng.range(0.8, 1.25);
    this.b[i] = this.params.b * rng.range(0.85, 1.15);
    this.s0[i] = this.params.s0;
    this.color[i] = Math.floor(rng.next() * 256);
    const v0 = this.graph.lanes[lane]!.speedLimit * this.speedFactor[i]!;
    this.v[i] = Math.min(v0 * 0.8, entrySpeed);
    this.acc[i] = 0;
    occupants.push(i);
    this.graph.lanes[lane]!.path.sample(0, this.pose, i * POSE_STRIDE);
    this.prevPose.set(this.pose.subarray(i * POSE_STRIDE, i * POSE_STRIDE + POSE_STRIDE), i * POSE_STRIDE);
    this.stats.spawned++;
    return i;
  }

  private despawn(i: number): void {
    this.alive[i] = 0;
    this.freeSlots.push(i);
    this.stats.exited++;
  }

  /** Rebuilds per-lane occupancy lists, sorted front (largest s) to back. */
  private bucket(): void {
    for (const list of this.laneVehicles) list.length = 0;
    for (let i = 0; i < this.capacity; i++) if (this.alive[i]) this.laneVehicles[this.lane[i]!]!.push(i);
    const s = this.s;
    for (const list of this.laneVehicles) if (list.length > 1) list.sort((a, b) => s[b]! - s[a]!);
  }

  private computeAccelerations(): void {
    const { lanes } = this.graph;
    const p: DriverParams = { T: 0, aMax: 0, b: 0, s0: 0 };
    for (let li = 0; li < lanes.length; li++) {
      const list = this.laneVehicles[li]!;
      const lane = lanes[li]!;
      for (let k = 0; k < list.length; k++) {
        const i = list[k]!;
        const route = this.routes[this.route[i]!]!;
        const ri = this.routeIdx[i]!;
        const v = this.v[i]!;
        p.T = this.T[i]!; p.aMax = this.aMax[i]!; p.b = this.b[i]!; p.s0 = this.s0[i]!;

        // Leader: the vehicle ahead on this lane, else the last vehicle on the next lanes of the route.
        let gap = Infinity, dv = 0;
        if (k > 0) {
          const j = list[k - 1]!;
          gap = this.s[j]! - this.length[j]! - this.s[i]!;
          dv = v - this.v[j]!;
        } else {
          let dist = lane.path.length - this.s[i]!;
          for (let r = ri + 1; r < route.length && dist < LOOKAHEAD; r++) {
            const ahead = this.laneVehicles[route[r]!]!;
            if (ahead.length > 0) {
              const j = ahead[ahead.length - 1]!;
              gap = dist + this.s[j]! - this.length[j]!;
              dv = v - this.v[j]!;
              break;
            }
            dist += lanes[route[r]!]!.path.length;
          }
        }

        // Desired speed, reduced ahead of slower lanes (e.g. a tight turn) so drivers brake in time.
        let v0 = lane.speedLimit * this.speedFactor[i]!;
        if (ri + 1 < route.length) {
          const nextLimit = lanes[route[ri + 1]!]!.speedLimit * this.speedFactor[i]!;
          v0 = Math.min(v0, approachSpeed(nextLimit, lane.path.length - this.s[i]!, p.b));
        }
        this.acc[i] = idmAccel(v, v0, gap, dv, p);
      }
    }
  }

  private integrate(dt: number): void {
    const { lanes } = this.graph;
    for (let i = 0; i < this.capacity; i++) {
      if (!this.alive[i]) continue;
      const a = this.acc[i]!, v = this.v[i]!;
      let v1 = v + a * dt, ds: number;
      if (v1 < 0) {
        ds = a < 0 ? (-v * v) / (2 * a) : 0; // stop exactly where speed reaches zero
        v1 = 0;
      } else {
        ds = v * dt + 0.5 * a * dt * dt;
      }
      this.v[i] = v1;
      let s = this.s[i]! + ds;
      const route = this.routes[this.route[i]!]!;
      let lane = lanes[this.lane[i]!]!;
      while (s >= lane.path.length) {
        s -= lane.path.length;
        const ri = ++this.routeIdx[i]!;
        if (ri >= route.length) break;
        this.lane[i] = route[ri]!;
        lane = lanes[route[ri]!]!;
      }
      if (this.routeIdx[i]! >= route.length) {
        this.despawn(i);
        continue;
      }
      this.s[i] = s;
    }
  }

  /** Reachable destinations per origin with their weights (computed once). */
  private destinations(sp: Spawner): { route: number; weight: number }[] {
    let d = this.destCache.get(sp.node);
    if (!d) {
      d = this.spawners
        .filter((o) => o.node !== sp.node && this.graph.sinks.has(o.node))
        .map((o) => ({ route: this.routeBetween(sp.node, o.node), weight: o.rate }))
        .filter((o) => o.route >= 0);
      this.destCache.set(sp.node, d);
    }
    return d;
  }

  private spawnTraffic(dt: number): void {
    for (const sp of this.spawners) {
      if (!this.graph.sources.has(sp.node)) continue;
      if (this.rng.next() < (sp.rate * dt) / 3600) sp.pending = Math.min(sp.pending + 1, 20);
      if (sp.pending === 0) continue;
      const options = this.destinations(sp);
      if (options.length === 0) continue;
      let total = 0;
      for (const o of options) total += o.weight;
      let r = this.rng.next() * total;
      let route = options[options.length - 1]!.route;
      for (const o of options) {
        if ((r -= o.weight) < 0) {
          route = o.route;
          break;
        }
      }
      if (this.spawn(route) >= 0) sp.pending--;
    }
  }

  private updatePoses(): void {
    const { lanes } = this.graph;
    this.prevPose.set(this.pose);
    let n = 0, sumV = 0;
    for (let i = 0; i < this.capacity; i++) {
      if (!this.alive[i]) continue;
      lanes[this.lane[i]!]!.path.sample(this.s[i]!, this.pose, i * POSE_STRIDE);
      n++;
      sumV += this.v[i]!;
    }
    this.stats.vehicles = n;
    this.stats.meanSpeed = n > 0 ? sumV / n : 0;
  }

  step(dt: number): void {
    this.bucket();
    this.computeAccelerations();
    this.integrate(dt);
    this.bucket();
    this.spawnTraffic(dt);
    this.updatePoses();
    this.time += dt;
  }
}

import { Rng } from '../core/rng';
import { type DriverParams, MAX_BRAKE, approachSpeed, idmAccel } from './idm';
import { type Conflict, JunctionModel, SIGNAL_RED, SIGNAL_YELLOW } from './junctions';
import type { Lane, LaneGraph } from './laneGraph';
import { type RouteTable, computeRouteTable } from './router';

/** Floats per pose: front bumper x, y, z, and heading. */
export const POSE_STRIDE = 4;
const LOOKAHEAD = 150; // metres scanned ahead along the route for a leader
const SPAWN_CLEARANCE = 8; // free metres needed at a lane start to insert a vehicle
const CONTROL_RANGE = 60; // drivers start reacting to junction control this far before the stop line
const GAP_RANGE = 35; // ...and to gaps in priority traffic this far
const STOP_BEFORE_LINE = 1; // metres
const LC_INTERVAL = 5; // steps between lane-change evaluations per vehicle (staggered)
const LC_COOLDOWN = 4; // s
const LAT_SPEED = 1.3; // m/s, visual sideways speed during a lane change
const GHOST_LAT = 1.2; // m: while further than this from its new lane, a changer still blocks the old one
const MOBIL = { politeness: 0.25, threshold: 0.2, bSafe: 4 };
const DEADLOCK_TIME = 6; // s stopped inside a junction before the deadlock breaker kicks in
const CRITICAL_GAP = 2.0; // s of margin when crossing in front of priority traffic

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
  /** Vehicles currently held by junction control (red light, give way, stop sign). */
  waiting: number;
  laneChanges: number;
  /** Vehicles that ended up in a lane that could not reach their destination (missed turn). */
  reroutes: number;
}

/** Time to cover `dist` from speed v, accelerating at `a` up to `vmax`. */
function timeTo(dist: number, v: number, a: number, vmax: number): number {
  if (dist <= 0) return 0;
  if (v >= vmax) return dist / Math.max(vmax, 0.1);
  const dAcc = (vmax * vmax - v * v) / (2 * a);
  if (dist <= dAcc) return (-v + Math.sqrt(v * v + 2 * a * dist)) / a;
  return (vmax - v) / a + (dist - dAcc) / vmax;
}

/**
 * Microscopic traffic simulation.
 *  - Car-following: IDM, with anticipation of slower lanes ahead (tight turns).
 *  - Junctions: signals, all-way stops, priority/give-way with gap acceptance over precomputed
 *    conflict zones; no entering an occupied zone or a full exit.
 *  - Lane changes: MOBIL with a strategic bias towards lanes that lead to the destination.
 * State is structure-of-arrays with a fixed capacity; the step is deterministic for a given seed.
 */
export class TrafficSim {
  readonly alive: Uint8Array;
  readonly lane: Int32Array;
  readonly dest: Int32Array; // destination node
  readonly s: Float32Array; // front bumper position along the current lane
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
  /** Junction state: committed to the next junction / held by control / time of stopping at an all-way stop. */
  readonly committed: Uint8Array;
  readonly waiting: Uint8Array;
  readonly stopTime: Float32Array;
  readonly lcCooldown: Float32Array;
  /** Visual lateral offset (m, + = right) left over from a lane change; decays to 0. */
  readonly lat: Float32Array;
  /** When the vehicle entered its current junction (Infinity while on a road lane). */
  readonly enterTime: Float32Array;
  /** Seconds stopped inside a junction, and whether the deadlock breaker is active for the vehicle. */
  readonly stuck: Float32Array;
  readonly breaking: Uint8Array;
  /** Lane the vehicle was on before its current one (-1 if none): its rear may still be there. */
  readonly lastLane: Int32Array;
  /** Lane a vehicle is changing out of, while it still physically overlaps it (else -1). */
  readonly fromLane: Int32Array;
  /** Poses at the previous and current step, for render interpolation. */
  readonly prevPose: Float32Array;
  readonly pose: Float32Array;

  readonly junctions: JunctionModel;
  private readonly tables = new Map<number, RouteTable>();
  private readonly destCache = new Map<number, { dest: number; weight: number }[]>();
  private readonly freeSlots: number[] = [];
  private readonly laneVehicles: number[][];
  /** Vehicles mid lane change that still block their old lane, per lane. */
  private readonly laneGhosts: number[][];
  private readonly rng: Rng;
  private readonly spawners: (Spawner & { pending: number })[];
  private readonly base: DriverParams = { T: 1.4, aMax: 1.5, b: 2, s0: 2 };
  private readonly p: DriverParams = { T: 0, aMax: 0, b: 0, s0: 0 };
  private readonly rearScratch = new Float32Array(4);
  private leadGap = Infinity;
  private leadV = 0;
  private steps = 0;

  time = 0;
  readonly stats: SimStats = { vehicles: 0, spawned: 0, exited: 0, meanSpeed: 0, waiting: 0, laneChanges: 0, reroutes: 0 };

  constructor(readonly graph: LaneGraph, spawners: Spawner[], seed: number, readonly capacity = 2048, junctions?: JunctionModel) {
    const f32 = (): Float32Array => new Float32Array(capacity);
    this.alive = new Uint8Array(capacity);
    this.lane = new Int32Array(capacity);
    this.dest = new Int32Array(capacity);
    this.s = f32(); this.v = f32(); this.acc = f32();
    this.length = f32(); this.width = f32(); this.height = f32();
    this.speedFactor = f32(); this.T = f32(); this.aMax = f32(); this.b = f32(); this.s0 = f32();
    this.color = new Uint8Array(capacity);
    this.committed = new Uint8Array(capacity);
    this.waiting = new Uint8Array(capacity);
    this.stopTime = f32();
    this.lcCooldown = f32();
    this.lat = f32();
    this.fromLane = new Int32Array(capacity).fill(-1);
    this.lastLane = new Int32Array(capacity).fill(-1);
    this.enterTime = new Float32Array(capacity).fill(Infinity);
    this.stuck = f32();
    this.breaking = new Uint8Array(capacity);
    this.prevPose = new Float32Array(capacity * POSE_STRIDE);
    this.pose = new Float32Array(capacity * POSE_STRIDE);
    for (let i = capacity - 1; i >= 0; i--) this.freeSlots.push(i);
    this.laneVehicles = graph.lanes.map(() => []);
    this.laneGhosts = graph.lanes.map(() => []);
    this.rng = new Rng(seed);
    this.junctions = junctions ?? new JunctionModel(graph);
    this.spawners = spawners
      .filter((sp) => graph.sources.has(sp.node) || graph.sinks.has(sp.node))
      .map((sp) => ({ ...sp, pending: 0 }));
  }

  /** Route table towards a destination node (computed once). */
  table(destNode: number): RouteTable {
    let t = this.tables.get(destNode);
    if (!t) {
      t = computeRouteTable(this.graph, this.graph.sinks.get(destNode) ?? []);
      this.tables.set(destNode, t);
    }
    return t;
  }

  /** Lane vehicle i will take after `laneId`, or -1. */
  private nextOf(i: number, laneId: number): number {
    return this.table(this.dest[i]!).next[laneId]!;
  }

  /** True if some entry lane at `source` can reach `destNode`. */
  canReach(source: number, destNode: number): boolean {
    const t = this.table(destNode);
    return (this.graph.sources.get(source) ?? []).some((l) => Number.isFinite(t.cost[l]!));
  }

  /** Inserts a vehicle at `source` heading to `destNode` if there is room. Returns the slot or -1. */
  spawn(source: number, destNode: number, opts: Partial<{ speedFactor: number; length: number }> = {}): number {
    const starts = this.graph.sources.get(source);
    if (!starts || this.freeSlots.length === 0) return -1;
    const table = this.table(destNode);
    let best = Infinity;
    for (const l of starts) best = Math.min(best, table.cost[l]!);
    if (!Number.isFinite(best)) return -1;
    // Any entry lane nearly as good as the best one, if it has room.
    const rng = this.rng;
    const first = Math.floor(rng.next() * starts.length);
    let lane = -1, entrySpeed = Infinity;
    for (let k = 0; k < starts.length && lane < 0; k++) {
      const l = starts[(first + k) % starts.length]!;
      if (table.cost[l]! > best + 8) continue;
      let ok = true, vMin = Infinity;
      for (const j of this.laneVehicles[l]!) {
        if (this.s[j]! - this.length[j]! < SPAWN_CLEARANCE) ok = false;
        vMin = Math.min(vMin, this.v[j]!);
      }
      if (ok) [lane, entrySpeed] = [l, vMin];
    }
    if (lane < 0) return -1;

    const i = this.freeSlots.pop()!;
    const van = rng.chance(0.1);
    this.alive[i] = 1;
    this.lane[i] = lane;
    this.dest[i] = destNode;
    this.s[i] = 0;
    this.length[i] = opts.length ?? (van ? rng.range(5.2, 6) : rng.range(4, 4.8));
    this.width[i] = van ? 2.0 : rng.range(1.75, 1.9);
    this.height[i] = van ? rng.range(2.1, 2.4) : rng.range(1.4, 1.6);
    this.speedFactor[i] = opts.speedFactor ?? rng.range(0.9, 1.08);
    this.T[i] = this.base.T * rng.range(0.85, 1.2);
    this.aMax[i] = this.base.aMax * rng.range(0.8, 1.25);
    this.b[i] = this.base.b * rng.range(0.85, 1.15);
    this.s0[i] = this.base.s0;
    this.color[i] = Math.floor(rng.next() * 256);
    this.committed[i] = 0;
    this.waiting[i] = 0;
    this.stopTime[i] = -1;
    this.lcCooldown[i] = LC_COOLDOWN;
    this.lat[i] = 0;
    this.fromLane[i] = -1;
    this.lastLane[i] = -1;
    this.enterTime[i] = Infinity;
    this.stuck[i] = 0;
    this.breaking[i] = 0;
    const v0 = this.graph.lanes[lane]!.speedLimit * this.speedFactor[i]!;
    this.v[i] = Math.min(v0 * 0.8, entrySpeed);
    this.acc[i] = 0;
    this.laneVehicles[lane]!.push(i);
    this.writePose(i);
    this.prevPose.set(this.pose.subarray(i * POSE_STRIDE, (i + 1) * POSE_STRIDE), i * POSE_STRIDE);
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
    for (const list of this.laneGhosts) list.length = 0;
    for (let i = 0; i < this.capacity; i++) {
      if (!this.alive[i]) continue;
      this.laneVehicles[this.lane[i]!]!.push(i);
      if (this.fromLane[i]! >= 0) {
        if (Math.abs(this.lat[i]!) > GHOST_LAT) this.laneGhosts[this.fromLane[i]!]!.push(i);
        else this.fromLane[i] = -1;
      }
    }
    const s = this.s;
    for (const list of this.laneVehicles) if (list.length > 1) list.sort((a, b) => s[b]! - s[a]!);
  }

  private loadParams(i: number): DriverParams {
    const p = this.p;
    p.T = this.T[i]!; p.aMax = this.aMax[i]!; p.b = this.b[i]!; p.s0 = this.s0[i]!;
    return p;
  }

  /**
   * Finds the nearest vehicle ahead of position s on `laneId` (then along i's route), ignoring
   * `skip`. Result in leadGap / leadV.
   */
  private findLeader(i: number, laneId: number, s: number, skip: number): void {
    const lanes = this.graph.lanes;
    const list = this.laneVehicles[laneId]!;
    this.leadGap = Infinity;
    this.leadV = 0;
    for (let k = list.length - 1; k >= 0; k--) {
      const j = list[k]!;
      if (j !== i && j !== skip && this.s[j]! > s) {
        this.leadGap = this.s[j]! - this.length[j]! - s;
        this.leadV = this.v[j]!;
        break;
      }
    }
    for (const j of this.laneGhosts[laneId]!) {
      if (j === i || j === skip || this.s[j]! <= s) continue;
      const gap = this.s[j]! - this.length[j]! - s;
      if (gap < this.leadGap) [this.leadGap, this.leadV] = [gap, this.v[j]!];
    }
    if (lanes[laneId]!.kind === 'connector') this.siblingLeader(i, laneId, -s, skip);
    if (this.leadGap < Infinity) return;

    const table = this.table(this.dest[i]!);
    let dist = lanes[laneId]!.path.length - s;
    for (let l = table.next[laneId]!; l >= 0 && dist < LOOKAHEAD; l = table.next[l]!) {
      const ahead = this.laneVehicles[l]!;
      for (let k = ahead.length - 1; k >= 0; k--) {
        const j = ahead[k]!;
        if (j === i || j === skip) continue;
        this.leadGap = dist + this.s[j]! - this.length[j]!;
        this.leadV = this.v[j]!;
        break;
      }
      if (lanes[l]!.kind === 'connector') this.siblingLeader(i, l, dist, skip);
      if (this.leadGap < Infinity) return;
      dist += lanes[l]!.path.length;
    }
  }

  /**
   * Where connectors split from one lane, a vehicle that has just turned onto a sibling connector
   * is still physically in front of us until its rear clears the split. `dist` = distance from our
   * front to the start of connector `l` (negative once we are on it). Tightens leadGap / leadV.
   */
  private siblingLeader(i: number, l: number, dist: number, skip: number): void {
    const lanes = this.graph.lanes;
    const from = lanes[l]!.prev[0];
    if (from === undefined) return;
    for (const k of lanes[from]!.next) {
      if (k === l) continue;
      if (-dist > this.junctions.splitDistance(l, k)) continue; // we are already clear of that path
      const sepK = this.junctions.splitDistance(k, l);
      const list = this.laneVehicles[k]!;
      for (let n = list.length - 1; n >= 0; n--) {
        const j = list[n]!;
        if (j === i || j === skip) continue;
        const rear = this.s[j]! - this.length[j]!;
        if (dist + this.s[j]! <= 0.5) continue; // behind us
        if (rear < sepK + 0.5) {
          const gap = dist + rear;
          if (gap < this.leadGap) [this.leadGap, this.leadV] = [gap, this.v[j]!];
        }
        break;
      }
    }
  }

  private desiredSpeed(i: number, laneId: number, s: number): number {
    const lanes = this.graph.lanes;
    const lane = lanes[laneId]!;
    const f = this.speedFactor[i]!;
    let v0 = lane.speedLimit * f;
    const nx = this.nextOf(i, laneId);
    if (nx >= 0) v0 = Math.min(v0, approachSpeed(lanes[nx]!.speedLimit * f, lane.path.length - s, this.b[i]!));
    return v0;
  }

  /** IDM acceleration of vehicle i if it were at (laneId, s), ignoring vehicle `skip`. */
  private followAccel(i: number, laneId: number, s: number, skip = -1): number {
    this.findLeader(i, laneId, s, skip);
    const v = this.v[i]!;
    return idmAccel(v, this.desiredSpeed(i, laneId, s), this.leadGap, v - this.leadV, this.loadParams(i));
  }

  /** Acceleration to stop with the front bumper `gap` metres ahead. */
  private stopAccel(i: number, gap: number): number {
    const v = this.v[i]!;
    return idmAccel(v, this.desiredSpeed(i, this.lane[i]!, this.s[i]!), Math.max(gap, 0.01), v, this.loadParams(i));
  }

  // ---------------------------------------------------------------- junction control

  /**
   * Must vehicle i hold before conflict zone `c`? Inside the junction the order of entry decides
   * (first in, first out), which makes circular waits impossible: i holds for vehicles that entered
   * before it if they are in the zone or about to reach it, and for later ones only if they are
   * physically in the zone already. As a last resort a vehicle stuck for a while ignores later,
   * equally stuck vehicles so a jam inside the junction always dissolves.
   */
  private zoneOccupied(i: number, c: Conflict): boolean {
    const mine = this.enterTime[i]!; // Infinity while still approaching
    if (this.stuck[i]! > DEADLOCK_TIME) this.breaking[i] = 1; // latches until we leave the junction
    const breaker = this.breaking[i] === 1;
    for (const j of this.laneVehicles[c.other]!) {
      const front = this.s[j]!, rear = front - this.length[j]!;
      if (rear > c.sOther + c.hOther) continue; // through
      const toZone = c.sOther - c.hOther - front;
      const earlier = this.enterTime[j]! < mine || (this.enterTime[j]! === mine && j < i);
      if (breaker && !earlier && this.stuck[j]! > 1) continue;
      if (toZone <= 0) return true; // inside the zone
      const vj = this.v[j]!;
      if (earlier && vj >= 1 && toZone < vj * 2) return true; // about to enter
    }
    return false;
  }

  /** Can vehicle i cross zone `c` without meeting a vehicle that is already inside the junction? */
  private insidersClear(i: number, C: Lane, d: number, c: Conflict): boolean {
    const list = this.laneVehicles[c.other]!;
    if (list.length === 0) return true;
    const v = this.v[i]!, vmax = C.speedLimit * this.speedFactor[i]!;
    const tIn = timeTo(d + c.sSelf - c.h, v, this.aMax[i]!, vmax);
    const tOut = timeTo(d + c.sSelf + c.h + this.length[i]!, v, this.aMax[i]!, vmax);
    for (const j of list) if (!this.clearOf(j, c.sOther - this.s[j]!, c, tIn, tOut)) return false;
    return true;
  }

  /**
   * Can vehicle i (front `d` m before connector C) cross conflict `c` before priority traffic
   * arrives? `distJ` is how far vehicle j's front is from the conflict point.
   */
  private clearOf(j: number, distJ: number, c: Conflict, tIn: number, tOut: number): boolean {
    if (distJ + this.length[j]! < -c.hOther) return true; // already through
    const dIn = distJ - c.hOther;
    if (dIn <= 0) return false; // in the zone
    if (this.waiting[j] && dIn > 2) return true; // held by its own control
    const vj = this.v[j]!;
    const tjIn = dIn / Math.max(vj, 0.1);
    const tjOut = (dIn + 2 * c.hOther + this.length[j]!) / Math.max(vj, 1);
    return tjIn > tOut + CRITICAL_GAP || tjOut < tIn - 0.3;
  }

  private gapOk(i: number, C: Lane, d: number, c: Conflict): boolean {
    const lanes = this.graph.lanes;
    const sig = this.junctions.signalOf[c.other];
    if (sig && sig.state(c.other) === SIGNAL_RED) return true;
    const v = this.v[i]!, vmax = C.speedLimit * this.speedFactor[i]!;
    const tIn = timeTo(d + c.sSelf - c.h, v, this.aMax[i]!, vmax);
    const tOut = timeTo(d + c.sSelf + c.h + this.length[i]!, v, this.aMax[i]!, vmax);
    for (const j of this.laneVehicles[c.other]!) {
      if (!this.clearOf(j, c.sOther - this.s[j]!, c, tIn, tOut)) return false;
    }
    const O = lanes[c.other]!;
    for (const p of O.prev) {
      const list = this.laneVehicles[p]!;
      const len = lanes[p]!.path.length;
      let seen = 0;
      for (const j of list) {
        if (this.nextOf(j, p) !== c.other) continue;
        const dist = len - this.s[j]! + c.sOther;
        if (dist > 120) break;
        if (!this.clearOf(j, dist, c, tIn, tOut)) return false;
        if (++seen >= 3) break;
      }
    }
    return true;
  }

  /** All-way stop: stop first, then go when no conflicting movement is active or queued earlier. */
  private allwayClear(i: number, C: Lane, d: number): boolean {
    if (this.stopTime[i]! < 0) {
      if (this.v[i]! < 0.5 && d < STOP_BEFORE_LINE + 4) this.stopTime[i] = this.time;
      else return false;
    }
    for (const c of this.junctions.conflicts[C.id]!) {
      for (const j of this.laneVehicles[c.other]!) {
        if (this.s[j]! - this.length[j]! < c.sOther + c.hOther) return false;
      }
    }
    const mine = this.stopTime[i]!;
    for (const laneId of this.junctions.incoming.get(C.node) ?? []) {
      const list = this.laneVehicles[laneId]!;
      if (list.length === 0) continue;
      const j = list[0]!;
      if (j === i || this.stopTime[j]! < 0) continue;
      const tj = this.stopTime[j]!;
      if (tj < mine || (tj === mine && j < i)) {
        const cj = this.nextOf(j, laneId);
        if (cj >= 0 && this.junctions.conflictSet[C.id]!.has(cj)) return false;
      }
    }
    return true;
  }

  /** Don't enter the junction unless there is room on the exit lane (no blocking the box). */
  private exitBlocked(i: number, C: Lane): boolean {
    const lanes = this.graph.lanes;
    const out = C.next[0]!;
    const list = this.laneVehicles[out]!;
    if (list.length === 0) return false;
    const last = list[list.length - 1]!;
    let space = this.s[last]! - this.length[last]!;
    if (space > 60 || this.v[last]! > 3) return false;
    for (const p of lanes[out]!.prev) {
      for (const j of this.laneVehicles[p]!) if (j !== i) space -= this.length[j]! + 2;
    }
    return space < this.length[i]! + 2.5;
  }

  private mustStop(i: number, C: Lane, d: number): boolean {
    const ctrl = this.junctions.control.get(C.node);
    if (!ctrl) return false;
    if (ctrl === 'signal') {
      const st = this.junctions.signalOf[C.id]!.state(C.id);
      const v = this.v[i]!;
      if (st === SIGNAL_RED) return true;
      if (st === SIGNAL_YELLOW && d > (v * v) / (2 * this.b[i]!) + 1) return true;
      // Only one vehicle per movement waits inside the junction for a gap; the rest wait at the line.
      for (const j of this.laneVehicles[C.id]!) if (this.waiting[j]) return true;
      // Clearance: let vehicles left over from the previous phase finish crossing first.
      for (const c of this.junctions.conflicts[C.id]!) {
        if (this.junctions.signalOf[c.other]!.state(c.other) !== SIGNAL_RED) continue;
        for (const j of this.laneVehicles[c.other]!) {
          if (this.s[j]! - this.length[j]! < c.sOther + c.hOther) return true;
        }
      }
    } else if (ctrl === 'allway') {
      if (!this.allwayClear(i, C, d)) return true;
    }
    if (ctrl !== 'allway' && d < GAP_RANGE) {
      for (const c of this.junctions.conflicts[C.id]!) if (c.yields && !this.gapOk(i, C, d, c)) return true;
    }
    // Vehicles already inside the junction have right of way over everyone still outside.
    if (d < GAP_RANGE) {
      for (const c of this.junctions.conflicts[C.id]!) if (!c.yields && !this.insidersClear(i, C, d, c)) return true;
    }
    return this.exitBlocked(i, C);
  }

  /** Upper bound on vehicle i's acceleration imposed by the junction ahead (Infinity if none). */
  private junctionLimit(i: number): number {
    const lanes = this.graph.lanes;
    const lane = lanes[this.lane[i]!]!;
    let C: Lane, d: number;
    if (lane.kind === 'connector') {
      C = lane;
      d = -this.s[i]!;
    } else {
      const nx = this.nextOf(i, lane.id);
      if (nx < 0 || lanes[nx]!.kind !== 'connector') return Infinity;
      C = lanes[nx]!;
      d = lane.path.length - this.s[i]!;
      if (d > CONTROL_RANGE) return Infinity;
    }
    let limit = Infinity;
    this.waiting[i] = 0;
    if (d > 0 && !this.committed[i]) {
      const v = this.v[i]!;
      if (this.mustStop(i, C, d)) {
        limit = this.stopAccel(i, d - STOP_BEFORE_LINE);
        this.waiting[i] = 1;
      } else if (d < (v * v) / (2 * this.b[i]!) + 2) {
        this.committed[i] = 1; // past the point where stopping is comfortable: go
      }
    }
    // Inside the junction: don't drive into an occupied conflict zone, and keep checking the gap
    // for movements we give way to (e.g. a left turn waiting for oncoming traffic on green).
    const pos = -d; // front position along C
    const v = this.v[i]!;
    const brake = (v * v) / (2 * MAX_BRAKE);
    const signal = this.junctions.control.get(C.node) === 'signal';
    for (const c of this.junctions.conflicts[C.id]!) {
      const entry = c.sSelf - c.h - pos;
      if (entry <= 0 || entry > 40) continue;
      let hold = this.zoneOccupied(i, c);
      // Waiting mid-junction is only safe at signals (crossing traffic has red); elsewhere drivers commit.
      if (!hold && signal && c.yields && pos >= 0 && entry > brake + 0.5) hold = !this.gapOk(i, C, d, c);
      if (hold) {
        limit = Math.min(limit, this.stopAccel(i, entry - 0.5));
        if (pos >= 0) this.waiting[i] = 1;
      }
    }
    return limit;
  }

  // ---------------------------------------------------------------- lane changes

  /** Strategic preference (m/s²) for moving from a lane with cost-to-go `cur` to one with `cand`. */
  private strategicBias(cur: number, cand: number, distToEnd: number): number {
    const urgency = Math.max(0, Math.min(1, 1 - distToEnd / 200));
    if (!Number.isFinite(cur)) return 2 + 6 * urgency;
    const diff = cur - cand; // > 0: candidate lane is better
    if (diff > 1) return Math.min(diff / 10, 1) * (0.5 + 5 * urgency);
    if (diff < -1) return -Math.min(-diff / 10, 1) * (0.5 + 5 * urgency) - 0.3;
    return 0;
  }

  private laneChanges(): void {
    const lanes = this.graph.lanes;
    for (let i = 0; i < this.capacity; i++) {
      if (!this.alive[i] || (i + this.steps) % LC_INTERVAL !== 0 || this.lcCooldown[i]! > 0) continue;
      const L = lanes[this.lane[i]!]!;
      if (L.kind !== 'road') continue;
      const group = this.graph.groups[L.group]!;
      const s = this.s[i]!;
      const distToEnd = L.path.length - s;
      if (group.length < 2 || s < 3 || distToEnd < 8 || this.waiting[i]) continue;

      const table = this.table(this.dest[i]!);
      const costCur = table.cost[L.id]!;
      const aMe = this.followAccel(i, L.id, s);
      // Current follower on my lane, with and without me ahead of it.
      const list = this.laneVehicles[L.id]!;
      const idx = list.indexOf(i);
      const of = idx >= 0 && idx + 1 < list.length ? list[idx + 1]! : -1;
      const aOF = of >= 0 ? this.followAccel(of, L.id, this.s[of]!) : 0;
      const aOFnew = of >= 0 ? this.followAccel(of, L.id, this.s[of]!, i) : 0;

      let best = -1, bestScore = MOBIL.threshold, bestS = 0;
      for (let dk = -1; dk <= 1; dk += 2) {
        const k = L.index + dk;
        if (k < 0 || k >= group.length) continue;
        const K = lanes[group[k]!]!;
        const costK = table.cost[K.id]!;
        if (!Number.isFinite(costK)) continue;
        const sK = (s * K.path.length) / L.path.length;
        // Neighbours on the target lane.
        const kl = this.laneVehicles[K.id]!;
        let nf = -1, unsafe = false;
        for (const j of kl) {
          const sj = this.s[j]!;
          if (sj >= sK) {
            if (sj - this.length[j]! - sK < 2 + 0.3 * this.v[i]!) unsafe = true; // too close to the new leader
          } else {
            if (sK - this.length[i]! - sj < 2 + 0.5 * this.v[j]!) unsafe = true; // too close to the new follower
            if (nf < 0) nf = j;
          }
        }
        if (unsafe) continue;
        const aMeNew = this.followAccel(i, K.id, sK);
        let aNF = 0, aNFnew = 0;
        if (nf >= 0) {
          aNF = this.followAccel(nf, K.id, this.s[nf]!);
          const v = this.v[nf]!;
          aNFnew = Math.min(aNF, idmAccel(v, this.desiredSpeed(nf, K.id, this.s[nf]!),
            sK - this.length[i]! - this.s[nf]!, v - this.v[i]!, this.loadParams(nf)));
          if (aNFnew < -MOBIL.bSafe) continue;
        }
        const incentive = aMeNew - aMe + MOBIL.politeness * (aNFnew - aNF + aOFnew - aOF);
        const score = incentive + this.strategicBias(costCur, costK, distToEnd);
        if (score > bestScore) [best, bestScore, bestS] = [K.id, score, sK];
      }
      if (best >= 0) {
        const K = lanes[best]!;
        this.lat[i] = this.lat[i]! + (K.index < L.index ? 1 : -1) * L.width;
        this.fromLane[i] = L.id;
        this.lastLane[i] = -1;
        this.lane[i] = best;
        this.s[i] = bestS;
        this.lcCooldown[i] = LC_COOLDOWN;
        this.stats.laneChanges++;
      }
    }
  }

  // ---------------------------------------------------------------- step

  private computeAccelerations(): void {
    for (let i = 0; i < this.capacity; i++) {
      if (!this.alive[i]) continue;
      this.acc[i] = Math.min(this.followAccel(i, this.lane[i]!, this.s[i]!), this.junctionLimit(i));
    }
  }

  /** Vehicle on a lane with no way to its destination: retarget to any reachable exit. */
  private reroute(i: number, laneId: number): number {
    this.stats.reroutes++;
    for (const sp of this.spawners) {
      if (!this.graph.sinks.has(sp.node)) continue;
      const t = this.table(sp.node);
      if (Number.isFinite(t.cost[laneId]!)) {
        this.dest[i] = sp.node;
        return t.next[laneId]!;
      }
    }
    return this.graph.lanes[laneId]!.next[0] ?? -1;
  }

  private integrate(dt: number): void {
    const lanes = this.graph.lanes;
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
      if (this.lcCooldown[i]! > 0) this.lcCooldown[i] = this.lcCooldown[i]! - dt;
      const lat = this.lat[i]!;
      if (lat !== 0) {
        const step = this.latSpeed(i) * dt;
        this.lat[i] = Math.abs(lat) <= step ? 0 : lat - Math.sign(lat) * step;
      }

      let s = this.s[i]! + ds;
      let lane = lanes[this.lane[i]!]!;
      let gone = false;
      while (s >= lane.path.length) {
        s -= lane.path.length;
        let nx = this.nextOf(i, lane.id);
        if (nx < 0) {
          if (lane.next.length === 0) {
            gone = true; // left the scene
            break;
          }
          nx = this.reroute(i, lane.id);
          if (nx < 0) {
            gone = true;
            break;
          }
        }
        this.lastLane[i] = lane.id;
        lane = lanes[nx]!;
        this.lane[i] = nx;
        this.fromLane[i] = -1;
        if (lane.kind === 'road') {
          this.committed[i] = 0;
          this.stopTime[i] = -1;
          this.enterTime[i] = Infinity;
          this.breaking[i] = 0;
        } else {
          this.committed[i] = 1;
          this.enterTime[i] = this.time;
        }
      }
      if (gone) {
        this.despawn(i);
      } else {
        this.s[i] = s;
        this.stuck[i] = lane.kind === 'connector' && v1 < 0.1 ? this.stuck[i]! + dt : 0;
      }
    }
  }

  /** Reachable destinations per origin with their weights (computed once). */
  private destinations(sp: Spawner): { dest: number; weight: number }[] {
    let d = this.destCache.get(sp.node);
    if (!d) {
      d = this.spawners
        .filter((o) => o.node !== sp.node && this.graph.sinks.has(o.node) && this.canReach(sp.node, o.node))
        .map((o) => ({ dest: o.node, weight: o.rate }));
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
      let dest = options[options.length - 1]!.dest;
      for (const o of options) {
        if ((r -= o.weight) < 0) {
          dest = o.dest;
          break;
        }
      }
      if (this.spawn(sp.node, dest) >= 0) sp.pending--;
    }
  }

  /** Sideways speed of the visual lane-change manoeuvre: slower when crawling in a queue. */
  private latSpeed(i: number): number {
    return Math.min(LAT_SPEED, 0.6 + 0.25 * this.v[i]!);
  }

  /** Pose = point on the lane, shifted sideways by the lane-change offset and yawed into the manoeuvre. */
  private writePose(i: number): void {
    const o = i * POSE_STRIDE;
    const lanes = this.graph.lanes;
    const lane = lanes[this.lane[i]!]!;
    const s = this.s[i]!;
    lane.path.sample(s, this.pose, o);
    // Heading from a trailing rear point, like a real car whose rear follows the path behind it.
    const back = this.length[i]! * 0.7;
    const r = this.rearScratch;
    const last = this.lastLane[i]!;
    if (s >= back || last < 0) {
      lane.path.sample(Math.max(s - back, 0), r, 0);
    } else {
      // The rear is still on the lane we came from (e.g. the end of a turn).
      const prev = lanes[last]!;
      prev.path.sample(prev.path.length - (back - s), r, 0);
    }
    const dx = this.pose[o]! - r[0]!, dz = this.pose[o + 2]! - r[2]!;
    if (dx * dx + dz * dz > 0.01) this.pose[o + 3] = Math.atan2(-dz, dx);
    const lat = this.lat[i]!;
    if (lat !== 0) {
      const h = this.pose[o + 3]!;
      this.pose[o] = this.pose[o]! + Math.sin(h) * lat;
      this.pose[o + 2] = this.pose[o + 2]! + Math.cos(h) * lat;
      this.pose[o + 3] = h + Math.atan2(Math.sign(lat) * this.latSpeed(i), Math.max(this.v[i]!, 8));
    }
  }

  private updatePoses(): void {
    this.prevPose.set(this.pose);
    let n = 0, sumV = 0, waiting = 0;
    for (let i = 0; i < this.capacity; i++) {
      if (!this.alive[i]) continue;
      this.writePose(i);
      n++;
      sumV += this.v[i]!;
      waiting += this.waiting[i]!;
    }
    this.stats.vehicles = n;
    this.stats.meanSpeed = n > 0 ? sumV / n : 0;
    this.stats.waiting = waiting;
  }

  step(dt: number): void {
    this.junctions.update(dt);
    this.bucket();
    this.laneChanges();
    this.bucket();
    this.computeAccelerations();
    this.integrate(dt);
    this.bucket();
    this.spawnTraffic(dt);
    this.updatePoses();
    this.time += dt;
    this.steps++;
  }
}

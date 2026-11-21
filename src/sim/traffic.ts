import { Rng } from '../core/rng';
import { type DriverParams, MAX_BRAKE, approachSpeed, idmAccel } from './idm';
import { type Conflict, JunctionModel, SIGNAL_RED, SIGNAL_YELLOW } from './junctions';
import { CURVE_BRAKE, type Lane, type LaneGraph, safeSpeedAt } from './laneGraph';
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
/** Lane-change manoeuvre length (m of travel): longer at speed, a short S-curve when crawling. */
const LC_MIN_LEN = 12;
const LC_MAX_LEN = 45;
const LC_LEN_PER_MS = 2.6; // extra metres per m/s of speed
/** The heading is taken from a point this far back along the car (fraction of its length). */
const REAR_FRAC = 0.7;
const GHOST_LAT = 1.2; // m: while further than this from its new lane, a changer still blocks the old one
const MOBIL = { politeness: 0.25, threshold: 0.2, bSafe: 4 };
const DEADLOCK_TIME = 6; // s stopped inside a junction before the deadlock breaker kicks in
const CRITICAL_GAP = 2.0; // s of margin when crossing in front of priority traffic
/** Impatience: after waiting this long (s) the margin has shrunk to MIN_CRITICAL_GAP. */
const PATIENCE = 35;
const MIN_CRITICAL_GAP = 1.0;

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

/** Left turns wait for oncoming traffic inside the junction, partway into the turn. */
function waitsInBox(C: Lane, c: Conflict): boolean {
  return C.turn === 'left' && c.oncoming;
}

/** Lane-change S-curve: 1 at the start (still on the old lane's line), 0 at the end. */
function lcProfile(u: number): number {
  if (u <= 0) return 1;
  if (u >= 1) return 0;
  return 0.5 * (1 + Math.cos(Math.PI * u));
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
  /** 1 for vans (taller, longer; drawn with the van model). */
  readonly van: Uint8Array;
  /** Junction state: committed to the next junction / held by control / time of stopping at an all-way stop. */
  readonly committed: Uint8Array;
  readonly waiting: Uint8Array;
  readonly stopTime: Float32Array;
  readonly lcCooldown: Float32Array;
  /** Visual lateral offset (m, + = right) of the front, left over from a lane change; goes to 0. */
  readonly lat: Float32Array;
  /**
   * Lane change in progress: the offset at the start (0 = none), metres travelled since, and the
   * manoeuvre length. The offset follows an S-curve over distance, so the car steers through
   * the change at any speed instead of sliding sideways.
   */
  readonly lcW: Float32Array;
  readonly lcDist: Float32Array;
  readonly lcLen: Float32Array;
  /** When the vehicle entered its current junction (Infinity while on a road lane). */
  readonly enterTime: Float32Array;
  /** Seconds spent held by junction control in a row (drivers accept smaller gaps over time). */
  readonly waitTime: Float32Array;
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
    this.van = new Uint8Array(capacity);
    this.committed = new Uint8Array(capacity);
    this.waiting = new Uint8Array(capacity);
    this.stopTime = f32();
    this.lcCooldown = f32();
    this.lat = f32();
    this.lcW = f32();
    this.lcDist = f32();
    this.lcLen = f32();
    this.fromLane = new Int32Array(capacity).fill(-1);
    this.lastLane = new Int32Array(capacity).fill(-1);
    this.enterTime = new Float32Array(capacity).fill(Infinity);
    this.waitTime = f32();
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
    this.van[i] = van && opts.length === undefined ? 1 : 0;
    this.committed[i] = 0;
    this.waiting[i] = 0;
    this.stopTime[i] = -1;
    this.lcCooldown[i] = LC_COOLDOWN;
    this.lat[i] = 0;
    this.lcW[i] = 0;
    this.fromLane[i] = -1;
    this.lastLane[i] = -1;
    this.enterTime[i] = Infinity;
    this.stuck[i] = 0;
    this.breaking[i] = 0;
    const v0 = safeSpeedAt(this.graph.lanes[lane]!, 0) * this.speedFactor[i]!;
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
        if (Math.max(Math.abs(this.lat[i]!), Math.abs(this.rearLat(i))) > GHOST_LAT) this.laneGhosts[this.fromLane[i]!]!.push(i);
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
    let v0 = safeSpeedAt(lane, s) * f; // lower inside bends
    const nx = this.nextOf(i, laneId);
    if (nx >= 0) v0 = Math.min(v0, approachSpeed(lanes[nx]!.speedLimit * f, lane.path.length - s, this.b[i]!));
    return v0;
  }

  /**
   * Braking for bends ahead (on this lane and the next one): once reaching a bend's speed by its
   * start needs CURVE_BRAKE, the driver brakes just hard enough. Infinity when no bend needs it.
   * (IDM alone only eases off, so cars would still be too fast when the bend begins.)
   */
  private bendAccel(i: number, laneId: number, s: number): number {
    const lanes = this.graph.lanes;
    const lane = lanes[laneId]!;
    const v = this.v[i]!, f = this.speedFactor[i]!;
    let a = Infinity;
    const check = (bends: Float32Array, offset: number): void => {
      for (let k = 0; k < bends.length; k += 3) {
        const d = bends[k]! + offset - s;
        if (d <= 0.5) continue; // inside it (or past): the cornering speed caps v0 instead
        const vt = bends[k + 2]! * f;
        if (v <= vt) continue;
        const need = (v * v - vt * vt) / (2 * d);
        if (need >= CURVE_BRAKE) a = Math.min(a, -Math.min(need, MAX_BRAKE));
      }
    };
    if (lane.curved) check(lane.bends, 0);
    const nx = this.nextOf(i, laneId);
    if (nx >= 0 && lanes[nx]!.curved) check(lanes[nx]!.bends, lane.path.length);
    return a;
  }

  /** IDM acceleration of vehicle i if it were at (laneId, s), ignoring vehicle `skip`. */
  private followAccel(i: number, laneId: number, s: number, skip = -1): number {
    this.findLeader(i, laneId, s, skip);
    const v = this.v[i]!;
    return Math.min(idmAccel(v, this.desiredSpeed(i, laneId, s), this.leadGap, v - this.leadV, this.loadParams(i)), this.bendAccel(i, laneId, s));
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

  /**
   * Both vehicle i (front `depth` m into zone `c`) and another vehicle are inside the same conflict
   * zone: true if the other one is further across (ties by slot), so i should stop. Exactly one of
   * two vehicles gets true, so they can never both drive on into each other.
   */
  private behindInZone(i: number, depth: number, c: Conflict): boolean {
    for (const j of this.laneVehicles[c.other]!) {
      const front = this.s[j]!;
      if (front - this.length[j]! > c.sOther + c.hOther) continue; // through
      const theirs = front - (c.sOther - c.hOther);
      if (theirs <= 0) continue; // not in the zone yet
      if (theirs > depth || (theirs === depth && j < i)) return true;
    }
    return false;
  }

  /** Can vehicle i cross zone `c` without meeting a vehicle that is already inside the junction? */
  private insidersClear(i: number, C: Lane, d: number, c: Conflict): boolean {
    const list = this.laneVehicles[c.other]!;
    if (list.length === 0) return true;
    const v = this.v[i]!, vmax = C.speedLimit * this.speedFactor[i]!;
    // Earliest arrival (no slowing for the turn yet) vs latest departure (at turning speed): judging
    // "they are through before I arrive" with a late arrival estimate would cut in front of them.
    const tIn = timeTo(d + c.sSelf - c.h, v, this.aMax[i]!, Math.max(vmax, v));
    const tOut = timeTo(d + c.sSelf + c.h + this.length[i]!, v, this.aMax[i]!, vmax);
    for (const j of list) if (!this.clearOf(j, c.sOther - this.s[j]!, c, tIn, tOut)) return false;
    return true;
  }

  /**
   * Can vehicle i (front `d` m before connector C) cross conflict `c` before priority traffic
   * arrives? `distJ` is how far vehicle j's front is from the conflict point.
   */
  private clearOf(j: number, distJ: number, c: Conflict, tIn: number, tOut: number, margin = CRITICAL_GAP): boolean {
    if (distJ + this.length[j]! < -c.hOther) return true; // already through
    const dIn = distJ - c.hOther;
    if (dIn <= 0) return false; // in the zone
    // Held by its own control (or waiting in the box for a gap) and able to stay before the zone.
    if (this.waiting[j] && dIn > 0.3 + (this.v[j]! * this.v[j]!) / 8) return true;
    const vj = this.v[j]!;
    const tjIn = dIn / Math.max(vj, 0.1);
    const tjOut = (dIn + 2 * c.hOther + this.length[j]!) / Math.max(vj, 1);
    return tjIn > tOut + margin || tjOut < tIn - 0.3;
  }

  private gapOk(i: number, C: Lane, d: number, c: Conflict): boolean {
    const lanes = this.graph.lanes;
    const sig = this.junctions.signalOf[c.other];
    if (sig && sig.state(c.other) === SIGNAL_RED) return true;
    const v = this.v[i]!, vmax = C.speedLimit * this.speedFactor[i]!;
    // Earliest arrival (no slowing for the turn yet) vs latest departure (at turning speed): judging
    // "they are through before I arrive" with a late arrival estimate would cut in front of them.
    const tIn = timeTo(d + c.sSelf - c.h, v, this.aMax[i]!, Math.max(vmax, v));
    const tOut = timeTo(d + c.sSelf + c.h + this.length[i]!, v, this.aMax[i]!, vmax);
    // Impatience: a driver who has waited a long time accepts a smaller (still safe) gap.
    const margin = Math.max(MIN_CRITICAL_GAP, CRITICAL_GAP - (CRITICAL_GAP - MIN_CRITICAL_GAP) * (this.waitTime[i]! / PATIENCE));
    for (const j of this.laneVehicles[c.other]!) {
      if (!this.clearOf(j, c.sOther - this.s[j]!, c, tIn, tOut, margin)) return false;
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
        if (!this.clearOf(j, dist, c, tIn, tOut, margin)) return false;
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

  /**
   * Don't enter the junction unless there is room on the exit lane (no blocking the box). Short
   * exit lanes (e.g. between the entries of a roundabout) are followed on along the way ahead
   * until there is room for a whole vehicle, so nobody stops with its tail in the junction.
   */
  private exitBlocked(i: number, C: Lane): boolean {
    const lanes = this.graph.lanes;
    const need = this.length[i]! + 2.5;
    const out = C.next[0]!;
    let space = 0;
    let lane = out;
    for (let hop = 0; hop < 4; hop++) {
      const list = this.laneVehicles[lane]!;
      if (list.length > 0) {
        const last = list[list.length - 1]!;
        const room = space + this.s[last]! - this.length[last]!;
        if (room > 60 || this.v[last]! > 3) return false;
        space = room;
        break;
      }
      space += lanes[lane]!.path.length;
      if (space >= need) break;
      // Continue along the way ahead: the straight-on (or only) successor of this lane.
      const L = lanes[lane]!;
      let nx = -1;
      for (const k of L.next) if (nx < 0 || lanes[k]!.turn === 'straight') nx = k;
      if (nx < 0) return false;
      lane = nx;
    }
    for (const p of lanes[out]!.prev) {
      for (const j of this.laneVehicles[p]!) if (j !== i) space -= this.length[j]! + 2;
    }
    return space < need;
  }

  private mustStop(i: number, C: Lane, d: number): boolean {
    const ctrl = this.junctions.control.get(C.node);
    if (!ctrl) return false;
    // Non-stop lanes cross nobody's path, so even queueing inside the junction blocks no one:
    // just follow the car ahead.
    if (this.junctions.free[C.id]) return false;
    if (ctrl === 'signal') {
      const st = this.junctions.signalOf[C.id]!.state(C.id);
      const v = this.v[i]!;
      if (st === SIGNAL_RED) return true;
      if (st === SIGNAL_YELLOW && d > (v * v) / (2 * this.b[i]!) + 1) return true;
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
    // Only one vehicle per movement waits inside the junction for a gap; the rest wait at the line.
    if (ctrl !== 'allway') for (const j of this.laneVehicles[C.id]!) if (this.waiting[j]) return true;
    // Look for gaps from before the point where stopping stops being comfortable (we commit there).
    const gapRange = Math.max(GAP_RANGE, (this.v[i]! * this.v[i]!) / (2 * this.b[i]!) + 10);
    if (ctrl !== 'allway' && d < gapRange) {
      for (const c of this.junctions.conflicts[C.id]!) {
        // Left turns wait for oncoming traffic inside the junction (see junctionLimit), not at the line.
        if (c.yields && !waitsInBox(C, c) && !this.gapOk(i, C, d, c)) return true;
      }
    }
    // Vehicles already inside the junction have right of way over everyone still outside.
    if (d < gapRange) {
      for (const c of this.junctions.conflicts[C.id]!) if (!c.yields && !this.insidersClear(i, C, d, c)) return true;
    }
    // Traffic circulating on a roundabout just follows the car ahead (holding back for room ahead
    // would lock a full ring); entering traffic must not block the ring.
    if (this.graph.circulating.has(C.id)) return false;
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
      if (entry <= 0) {
        // Already in the zone: if the other vehicle is in it too and further across, stop and let it clear.
        if (pos < c.sSelf + c.h && this.behindInZone(i, -entry, c)) {
          limit = Math.min(limit, this.stopAccel(i, 0));
          this.waiting[i] = 1;
        }
        continue;
      }
      if (entry > 40) continue;
      let hold = this.zoneOccupied(i, c);
      // Waiting mid-junction: left turns pull in and wait for a gap in oncoming traffic; at signals
      // any movement may wait inside (crossing traffic has red). Elsewhere drivers commit.
      const inBox = waitsInBox(C, c) || (signal && pos >= 0);
      if (!hold && c.yields && inBox && entry > brake + 0.5) hold = !this.gapOk(i, C, d, c);
      if (hold) {
        limit = Math.min(limit, this.stopAccel(i, entry - 0.5));
        this.waiting[i] = 1;
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
      if (!this.alive[i] || (i + this.steps) % LC_INTERVAL !== 0 || this.lcCooldown[i]! > 0 || this.lcW[i] !== 0) continue;
      const L = lanes[this.lane[i]!]!;
      if (L.kind !== 'road') continue;
      const group = this.graph.groups[L.group]!;
      const s = this.s[i]!;
      const distToEnd = L.path.length - s;
      // The whole manoeuvre (front and rear) must fit before the end of the lane.
      const back = this.length[i]! * REAR_FRAC;
      const lcLen = Math.min(LC_MAX_LEN, 8 + LC_LEN_PER_MS * this.v[i]!, distToEnd - back - 2);
      if (group.length < 2 || s < 3 || lcLen < LC_MIN_LEN || this.waiting[i]) continue;

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
        // Vehicles still moving out of the target lane occupy it too (no swapping lanes through each other).
        for (const j of this.laneGhosts[K.id]!) {
          const Lj = lanes[this.lane[j]!]!;
          const sj = (this.s[j]! * K.path.length) / Lj.path.length;
          if (sj + 2 > sK - this.length[i]! - 2 && sj - this.length[j]! - 2 < sK + 2) unsafe = true;
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
        this.lat[i] = (K.index < L.index ? 1 : -1) * L.width;
        this.lcW[i] = this.lat[i]!;
        this.lcDist[i] = 0;
        this.lcLen[i] = Math.max(LC_MIN_LEN, lcLen);
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
      let a = Math.min(this.followAccel(i, this.lane[i]!, this.s[i]!), this.junctionLimit(i));
      // Mid lane change: still partly in the old lane, so keep clear of its traffic ahead too.
      const from = this.fromLane[i]!;
      if (from >= 0) {
        const lanes = this.graph.lanes;
        const sFrom = (this.s[i]! * lanes[from]!.path.length) / lanes[this.lane[i]!]!.path.length;
        a = Math.min(a, this.followAccel(i, from, sFrom));
      }
      this.acc[i] = a;
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
      this.waitTime[i] = this.waiting[i] && v1 < 2 ? this.waitTime[i]! + dt : 0;
      if (this.lcW[i] !== 0) {
        const d = this.lcDist[i]! + ds;
        this.lcDist[i] = d;
        this.lat[i] = this.lcW[i]! * lcProfile(d / this.lcLen[i]!);
        // Done once the rear has followed the front through the whole S-curve.
        if (d >= this.lcLen[i]! + this.length[i]! * REAR_FRAC) {
          this.lcW[i] = 0;
          this.lat[i] = 0;
        }
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

  /**
   * Pose = front bumper on the lane, shifted sideways by the lane-change offset. The heading
   * points from a trailing rear point (on the path behind, with the offset the front had when it
   * was there) to the front, like a real car whose rear follows the path of its front wheels.
   */
  private writePose(i: number): void {
    const o = i * POSE_STRIDE;
    const lanes = this.graph.lanes;
    const lane = lanes[this.lane[i]!]!;
    const s = this.s[i]!;
    const pose = this.pose;
    lane.path.sample(s, pose, o);
    const back = this.length[i]! * REAR_FRAC;
    const r = this.rearScratch;
    const last = this.lastLane[i]!;
    if (s >= back || last < 0) {
      lane.path.sample(Math.max(s - back, 0), r, 0);
    } else {
      // The rear is still on the lane we came from (e.g. the end of a turn).
      const prev = lanes[last]!;
      prev.path.sample(prev.path.length - (back - s), r, 0);
    }
    const W = this.lcW[i]!;
    if (W !== 0) {
      const latF = this.lat[i]!;
      const latR = this.rearLat(i);
      // Offsets to the right of the path's own heading at each point: (sin h, cos h).
      const hf = pose[o + 3]!, hr = r[3]!;
      pose[o] = pose[o]! + Math.sin(hf) * latF;
      pose[o + 2] = pose[o + 2]! + Math.cos(hf) * latF;
      r[0] = r[0]! + Math.sin(hr) * latR;
      r[2] = r[2]! + Math.cos(hr) * latR;
    }
    const dx = pose[o]! - r[0]!, dz = pose[o + 2]! - r[2]!;
    if (dx * dx + dz * dz > 0.01) pose[o + 3] = Math.atan2(-dz, dx);
  }

  /** Lane-change offset at the trailing rear point (it passes each spot after the front). */
  private rearLat(i: number): number {
    const W = this.lcW[i]!;
    return W === 0 ? 0 : W * lcProfile((this.lcDist[i]! - this.length[i]! * REAR_FRAC) / this.lcLen[i]!);
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

  /**
   * Takes over the vehicles of a simulation running on an older version of the network (after an
   * edit), so traffic keeps flowing. Vehicles keep their slot and driver parameters and are placed
   * on the matching lane of the new graph. Vehicles whose road is gone, or that can no longer
   * reach any exit, are removed. Returns the number removed.
   */
  adopt(old: TrafficSim): number {
    if (old.capacity !== this.capacity) throw new Error('adopt: capacity mismatch');
    const lanes = this.graph.lanes;
    const roadLanes = lanes.filter((l) => l.kind === 'road');
    const scratch = new Float32Array(4);
    const memo = new Map<number, number>();

    /** New road lane at the position (x, z) of old lane `ol`, or -1. Returns [lane, s]. */
    const mapRoad = (ol: Lane, s: number): [number, number] => {
      ol.path.sample(s, scratch, 0);
      const x = scratch[0]!, z = scratch[2]!;
      const dir = ol.path.dirAt(false);
      let best = -1, bestS = 0, bestD = Infinity;
      // Same road and direction still there: pick the same lane index if possible.
      const same = roadLanes.filter((l) => l.segment === ol.segment && l.fromNode === ol.fromNode && l.toNode === ol.toNode);
      const pool = same.length > 0 ? same : roadLanes;
      for (const l of pool) {
        if (same.length === 0 && l.path.dirAt(false)[0] * dir[0] + l.path.dirAt(false)[2] * dir[2] < -0.5) continue;
        const p = l.path.project(x, z);
        const penalty = same.length > 0 ? Math.abs(l.index - ol.index) * 0.01 : 0;
        if (p.dist + penalty < bestD) [best, bestS, bestD] = [l.id, p.s, p.dist + penalty];
      }
      // Same road: allow a lane's width of sideways shift (lanes removed) or a few metres past the
      // lane end (the junction grew). Other roads (a split or redrawn road): must line up closely.
      if (best < 0 || bestD > (same.length > 0 ? 4 : 1.2)) return [-1, 0];
      return [best, Math.min(bestS, lanes[best]!.path.length - 0.01)];
    };
    const mapLaneEnd = (laneId: number, end: boolean): number => {
      const key = laneId * 2 + (end ? 1 : 0);
      let r = memo.get(key);
      if (r === undefined) {
        const ol = old.graph.lanes[laneId]!;
        r = mapRoad(ol, end ? ol.path.length - 0.5 : 0.5)[0];
        memo.set(key, r);
      }
      return r;
    };

    let dropped = 0;
    this.freeSlots.length = 0;
    for (let i = 0; i < this.capacity; i++) {
      this.alive[i] = 0;
      if (!old.alive[i]) continue;
      const ol = old.graph.lanes[old.lane[i]!]!;
      let lane = -1, s = 0, last = -1;
      if (ol.kind === 'road') {
        [lane, s] = mapRoad(ol, old.s[i]!);
      } else {
        // Connector: find the new connector joining the same two roads lanes.
        const from = mapLaneEnd(ol.prev[0]!, true), to = mapLaneEnd(ol.next[0]!, false);
        if (from >= 0 && to >= 0) {
          const c = lanes[from]!.next.find((n) => lanes[n]!.kind === 'connector' && lanes[n]!.next[0] === to);
          if (c !== undefined) {
            lane = c;
            s = Math.min((old.s[i]! / ol.path.length) * lanes[c]!.path.length, lanes[c]!.path.length - 0.01);
            last = from;
          }
        }
      }
      if (lane >= 0) {
        let dest = old.dest[i]!;
        if (!Number.isFinite(this.table(dest).cost[lane]!)) {
          dest = -1;
          for (const sp of this.spawners) {
            if (this.graph.sinks.has(sp.node) && Number.isFinite(this.table(sp.node).cost[lane]!)) {
              dest = sp.node;
              break;
            }
          }
        }
        if (dest < 0) lane = -1;
        else this.dest[i] = dest;
      }
      if (lane < 0) {
        dropped++;
        continue;
      }
      this.alive[i] = 1;
      this.lane[i] = lane;
      this.s[i] = s;
      this.v[i] = old.v[i]!;
      this.acc[i] = 0;
      for (const k of ['length', 'width', 'height', 'speedFactor', 'T', 'aMax', 'b', 's0'] as const) this[k][i] = old[k][i]!;
      this.color[i] = old.color[i]!;
      this.van[i] = old.van[i]!;
      const onConnector = lanes[lane]!.kind === 'connector';
      this.committed[i] = onConnector ? 1 : 0;
      this.waiting[i] = 0;
      this.stopTime[i] = -1;
      this.lcCooldown[i] = old.lcCooldown[i]!;
      this.lat[i] = 0;
      this.lcW[i] = 0;
      this.fromLane[i] = -1;
      this.lastLane[i] = last;
      this.enterTime[i] = onConnector ? old.time : Infinity;
      this.stuck[i] = 0;
      this.breaking[i] = 0;
    }
    // Vehicles squeezed onto the same lane (e.g. a lane was removed, or a junction grew and
    // shortened its approach) must not overlap each other, nor the tail of a vehicle that has
    // just entered the junction from this lane.
    this.bucket();
    for (let id = 0; id < lanes.length; id++) {
      const list = this.laneVehicles[id]!;
      const len = lanes[id]!.path.length;
      let rear = Infinity;
      for (const c of lanes[id]!.next) {
        for (const j of this.laneVehicles[c]!) {
          if (this.s[j]! < this.length[j]!) rear = Math.min(rear, len + this.s[j]! - this.length[j]!);
        }
      }
      for (const j of list) {
        if (this.s[j]! > rear - 0.5) {
          this.alive[j] = 0;
          dropped++;
        } else {
          rear = this.s[j]! - this.length[j]!;
        }
      }
    }
    for (let i = this.capacity - 1; i >= 0; i--) if (!this.alive[i]) this.freeSlots.push(i);
    this.time = old.time;
    this.steps = old.steps;
    Object.assign(this.stats, old.stats);
    for (const sp of this.spawners) sp.pending = old.spawners.find((o) => o.node === sp.node)?.pending ?? 0;
    this.bucket();
    this.updatePoses();
    this.prevPose.set(this.pose);
    return dropped;
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

import { describe, expect, it } from 'vitest';
import { lotsOverlap } from '../src/env/city';
import { TEST_SEED, buildTestNetwork, testSpawners } from '../src/game/testScene';
import { type JunctionControl, type LaneProfile, RoadNetwork } from '../src/network/network';
import { idmAccel } from '../src/sim/idm';
import { SIGNAL_GREEN, SIGNAL_RED, SIGNAL_YELLOW } from '../src/sim/junctions';
import { LaneGraph } from '../src/sim/laneGraph';
import { Path } from '../src/sim/path';
import { type Spawner, TrafficSim } from '../src/sim/traffic';

const DT = 0.1;
const PARAMS = { T: 1.4, aMax: 1.5, b: 2, s0: 2 };
const ARTERIAL: LaneProfile = { forward: 2, backward: 2, laneWidth: 3.5, sidewalk: 2.5, speedLimit: 50 };
const LOCAL: LaneProfile = { forward: 1, backward: 1, laneWidth: 3.25, sidewalk: 2.5, speedLimit: 40 };

/** Straight two-way road between two dead ends, 50 km/h. */
function straightRoad(lanes = 1, length = 1500) {
  const net = new RoadNetwork();
  const a = net.addNode([0, 0, 0]), b = net.addNode([length, 0, 0]);
  net.addSegment(a, b, { forward: lanes, backward: lanes, laneWidth: 3.5, sidewalk: 0, speedLimit: 50 });
  const sim = new TrafficSim(new LaneGraph(net), [], 1);
  return { sim, a, b, limit: 50 / 3.6 };
}

/** A single junction at the origin with arms to dead ends; returns the sim with demand on every arm. */
function junction(control: JunctionControl, arms: [number, number, LaneProfile][], rate: number, seed = 7) {
  const net = new RoadNetwork();
  const c = net.addNode([0, 0, 0]);
  net.node(c).control = control;
  const spawners: Spawner[] = [];
  for (const [x, z, p] of arms) {
    const end = net.addNode([x, 0, z]);
    net.addSegment(c, end, p);
    spawners.push({ node: end, rate });
  }
  return new TrafficSim(new LaneGraph(net), spawners, seed);
}

/** Pairs of vehicles whose (slightly shrunk) footprints overlap. */
function overlaps(sim: TrafficSim, shrink = 0.8): number {
  const boxes: Parameters<typeof lotsOverlap>[0][] = [];
  for (let i = 0; i < sim.capacity; i++) {
    if (!sim.alive[i]) continue;
    const x = sim.pose[i * 4]!, z = sim.pose[i * 4 + 2]!, h = sim.pose[i * 4 + 3]!;
    const half = sim.length[i]! / 2;
    boxes.push({
      cx: x - Math.cos(h) * half, cz: z + Math.sin(h) * half, angle: h,
      hx: half * shrink, hz: (sim.width[i]! / 2) * shrink, kind: 'house', inZone: false,
    });
  }
  let n = 0;
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) if (lotsOverlap(boxes[i]!, boxes[j]!)) n++;
  return n;
}

/** Runs the sim and tracks collisions and the longest time any vehicle stood still. */
function run(sim: TrafficSim, seconds: number) {
  let collisions = 0, longestStop = 0;
  const still = new Float32Array(sim.capacity);
  for (let t = 1; t <= seconds / DT; t++) {
    sim.step(DT);
    for (let i = 0; i < sim.capacity; i++) {
      still[i] = sim.alive[i] && sim.v[i]! < 0.1 ? still[i]! + DT : 0;
      longestStop = Math.max(longestStop, still[i]!);
    }
    if (t % 10 === 0) collisions += overlaps(sim);
  }
  return { collisions, longestStop };
}

const CROSS: [number, number, LaneProfile][] = [[200, 0, ARTERIAL], [-200, 0, ARTERIAL], [0, 200, ARTERIAL], [0, -200, ARTERIAL]];
const MIXED: [number, number, LaneProfile][] = [[200, 0, ARTERIAL], [-200, 0, ARTERIAL], [0, 200, LOCAL], [0, -200, LOCAL]];

describe('Path', () => {
  it('samples position and heading', () => {
    const p = new Path([[0, 0, 0], [10, 0, 0], [10, 0, 10]]);
    expect(p.length).toBeCloseTo(20);
    const out = new Float32Array(4);
    p.sample(15, out);
    expect([...out.subarray(0, 3)]).toEqual([10, 0, 5]);
    expect(out[3]).toBeCloseTo(-Math.PI / 2); // heading towards +z
  });
});

describe('IDM', () => {
  it('accelerates on a free road and brakes behind a close leader', () => {
    expect(idmAccel(5, 14, Infinity, 0, PARAMS)).toBeGreaterThan(1);
    expect(idmAccel(14, 14, Infinity, 0, PARAMS)).toBeCloseTo(0);
    expect(idmAccel(14, 14, 5, 14, PARAMS)).toBeLessThan(-5);
  });
});

describe('LaneGraph on the test city', () => {
  const net = buildTestNetwork();
  const g = new LaneGraph(net);

  it('has entry and exit lanes at every road leaving the scene', () => {
    const deadEnds = [...net.nodes.values()].filter((n) => n.segments.length === 1);
    expect(g.sources.size).toBe(deadEnds.length);
    expect(g.sinks.size).toBe(deadEnds.length);
  });

  it('lets every lane continue unless it leaves the scene', () => {
    const sinkLanes = new Set([...g.sinks.values()].flat());
    for (const l of g.lanes) if (!sinkLanes.has(l.id)) expect(l.next.length, `lane ${l.id}`).toBeGreaterThan(0);
  });

  it('connects lanes without gaps', () => {
    for (const l of g.lanes) {
      for (const nx of l.next) {
        const a = l.path.point(l.path.count - 1), b = g.lanes[nx]!.path.point(0);
        expect(Math.hypot(a[0] - b[0], a[2] - b[2])).toBeLessThan(0.05);
      }
    }
  });

  it('slows connectors for tight turns', () => {
    const turns = g.lanes.filter((l) => l.kind === 'connector' && l.turn !== 'straight');
    expect(turns.length).toBeGreaterThan(0);
    for (const t of turns) expect(t.speedLimit).toBeLessThan(40 / 3.6);
  });
});

describe('car-following', () => {
  it('a lone vehicle reaches its desired speed', () => {
    const { sim, a, b, limit } = straightRoad();
    const i = sim.spawn(a, b, { speedFactor: 1 });
    for (let t = 0; t < 600; t++) sim.step(DT);
    expect(sim.v[i]).toBeGreaterThan(limit * 0.97);
    expect(sim.v[i]).toBeLessThanOrEqual(limit * 1.001);
  });

  it('followers queue behind a slow leader without overlapping', () => {
    const { sim, a, b } = straightRoad();
    const lane = sim.graph.sources.get(a)![0]!;
    sim.spawn(a, b, { speedFactor: 0.3 });
    let minGap = Infinity;
    for (let t = 0; t < 900; t++) {
      if (t % 25 === 0) sim.spawn(a, b, { speedFactor: 1.1 });
      sim.step(DT);
      const onLane = [...Array(sim.capacity).keys()]
        .filter((i) => sim.alive[i] && sim.lane[i] === lane)
        .sort((x, y) => sim.s[y]! - sim.s[x]!);
      for (let k = 1; k < onLane.length; k++) {
        const lead = onLane[k - 1]!, fol = onLane[k]!;
        minGap = Math.min(minGap, sim.s[lead]! - sim.length[lead]! - sim.s[fol]!);
      }
    }
    expect(sim.stats.vehicles).toBeGreaterThan(10);
    expect(minGap).toBeGreaterThan(1);
  });
});

describe('turn motion', () => {
  it('heading changes smoothly through a turn, including when the turn ends', () => {
    const net = new RoadNetwork();
    const c = net.addNode([0, 0, 0]);
    const west = net.addNode([-150, 0, 0]), east = net.addNode([150, 0, 0]), south = net.addNode([0, 0, 150]);
    for (const n of [west, east, south]) net.addSegment(c, n, LOCAL);
    const sim = new TrafficSim(new LaneGraph(net), [], 1);
    for (const [from, to] of [[west, south], [south, west], [south, east], [east, south]] as const) {
      const i = sim.spawn(from, to, { speedFactor: 1 });
      let prev = NaN, maxStep = 0;
      for (let t = 0; t < 400 && sim.alive[i]; t++) {
        sim.step(DT);
        const h = sim.pose[i * 4 + 3]!;
        if (!Number.isNaN(prev)) {
          let d = Math.abs(h - prev);
          if (d > Math.PI) d = 2 * Math.PI - d;
          maxStep = Math.max(maxStep, d);
        }
        prev = h;
      }
      // A car at turning speed rotates well under 0.1 rad per 0.1 s step; a snap would be ~0.3+.
      expect(maxStep, `${from}→${to}`).toBeLessThan(0.12);
    }
  });
});

describe('lane changes', () => {
  it('faster vehicles overtake a slow one on a two-lane road', () => {
    const { sim, a, b } = straightRoad(2);
    const slow = sim.spawn(a, b, { speedFactor: 0.35 });
    for (let t = 0; t < 1200; t++) {
      if (t % 40 === 20) sim.spawn(a, b, { speedFactor: 1.05 });
      sim.step(DT);
    }
    expect(sim.stats.laneChanges).toBeGreaterThan(3);
    // Someone that started after the slow vehicle is now ahead of it.
    const ahead = [...Array(sim.capacity).keys()].some((i) => i !== slow && sim.alive[i] && sim.s[i]! > sim.s[slow]! + 20);
    expect(ahead || sim.stats.exited > 0).toBe(true);
    expect(overlaps(sim)).toBe(0);
  });
});

describe('signals', () => {
  it('cycles green → yellow → red and gives each approach pair its own phase', () => {
    const sim = junction('signal', CROSS, 0);
    const ctrl = [...sim.junctions.signals.values()][0]!;
    expect(ctrl.phases).toHaveLength(2);
    const conn = ctrl.phases[0]!.connectors[0]!;
    const other = ctrl.phases[1]!.connectors[0]!;
    const seen = new Set<number>();
    for (let t = 0; t < ctrl.cycle / DT; t++) {
      const st = ctrl.state(conn);
      seen.add(st);
      if (st === SIGNAL_GREEN) expect(ctrl.state(other)).toBe(SIGNAL_RED);
      ctrl.update(DT);
    }
    expect([...seen].sort()).toEqual([SIGNAL_GREEN, SIGNAL_YELLOW, SIGNAL_RED]);
  });
});

describe('junction scenarios (no collisions, no gridlock)', () => {
  for (const [name, control, arms, rate] of [
    ['signalised 4-way', 'signal', CROSS, 700],
    ['priority 4-way (main + side road)', 'priority', MIXED, 450],
    ['all-way stop', 'allway', [[150, 0, LOCAL], [-150, 0, LOCAL], [0, 150, LOCAL], [0, -150, LOCAL]], 200],
    ['priority T-junction', 'priority', [[200, 0, ARTERIAL], [-200, 0, ARTERIAL], [0, 200, LOCAL]], 500],
  ] as const) {
    it(name, () => {
      const sim = junction(control, arms as unknown as [number, number, LaneProfile][], rate);
      const { collisions, longestStop } = run(sim, 900);
      expect(collisions, 'overlapping vehicles').toBe(0);
      expect(longestStop, 'longest standstill (s)').toBeLessThan(150);
      expect(sim.stats.exited).toBeGreaterThan(100);
    });
  }
});

describe('test city', () => {
  it('runs deterministically, delivers vehicles and never gridlocks', () => {
    const make = () => {
      const net = buildTestNetwork();
      return new TrafficSim(new LaneGraph(net), testSpawners(net), TEST_SEED);
    };
    const a = make(), b = make();
    const ra = run(a, 600);
    for (let t = 0; t < 6000; t++) b.step(DT);
    expect(a.stats).toEqual(b.stats);
    expect(a.pose).toEqual(b.pose);
    expect(a.stats.exited).toBeGreaterThan(200);
    expect(ra.collisions).toBe(0);
    expect(ra.longestStop).toBeLessThan(150);
    expect(a.stats.reroutes).toBeLessThan(a.stats.exited * 0.05);
  });
});

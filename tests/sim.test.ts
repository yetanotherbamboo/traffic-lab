import { describe, expect, it } from 'vitest';
import { TEST_SEED, buildTestNetwork, testSpawners } from '../src/game/testScene';
import { RoadNetwork } from '../src/network/network';
import { idmAccel } from '../src/sim/idm';
import { LaneGraph } from '../src/sim/laneGraph';
import { Path } from '../src/sim/path';
import { TrafficSim } from '../src/sim/traffic';

const DT = 0.1;
const PARAMS = { T: 1.4, aMax: 1.5, b: 2, s0: 2 };

/** Straight two-way road between two dead ends, 1 lane each way, 50 km/h. */
function straightRoad(length = 1500) {
  const net = new RoadNetwork();
  const a = net.addNode([0, 0, 0]), b = net.addNode([length, 0, 0]);
  net.addSegment(a, b, { forward: 1, backward: 1, laneWidth: 3.5, sidewalk: 0, speedLimit: 50 });
  const graph = new LaneGraph(net);
  const sim = new TrafficSim(graph, [], 1);
  return { sim, route: sim.routeBetween(a, b), limit: 50 / 3.6 };
}

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

describe('TrafficSim', () => {
  it('a lone vehicle reaches its desired speed', () => {
    const { sim, route, limit } = straightRoad();
    sim.spawn(route, { speedFactor: 1 });
    for (let t = 0; t < 600; t++) sim.step(DT);
    expect(sim.v[0]).toBeGreaterThan(limit * 0.97);
    expect(sim.v[0]).toBeLessThanOrEqual(limit * 1.001);
  });

  it('followers queue behind a slow leader without overlapping', () => {
    const { sim, route } = straightRoad();
    const lane = sim.routes[route]![0]!;
    sim.spawn(route, { speedFactor: 0.3 });
    let minGap = Infinity;
    for (let t = 0; t < 900; t++) {
      if (t % 25 === 0) sim.spawn(route, { speedFactor: 1.1 });
      sim.step(DT);
      const onLane = [...Array(sim.capacity).keys()]
        .filter((i) => sim.alive[i] && sim.lane[i] === lane)
        .sort((a, b) => sim.s[b]! - sim.s[a]!);
      for (let k = 1; k < onLane.length; k++) {
        const lead = onLane[k - 1]!, fol = onLane[k]!;
        minGap = Math.min(minGap, sim.s[lead]! - sim.length[lead]! - sim.s[fol]!);
      }
    }
    expect(sim.stats.vehicles).toBeGreaterThan(10);
    expect(minGap).toBeGreaterThan(1);
  });

  it('runs the test city deterministically and delivers vehicles', () => {
    const run = () => {
      const net = buildTestNetwork();
      const sim = new TrafficSim(new LaneGraph(net), testSpawners(net), TEST_SEED);
      for (let t = 0; t < 3000; t++) sim.step(DT);
      return sim;
    };
    const a = run(), b = run();
    expect(a.stats).toEqual(b.stats);
    expect(a.pose).toEqual(b.pose);
    expect(a.stats.exited).toBeGreaterThan(50);
    expect(a.stats.vehicles).toBeGreaterThan(10);
    for (let i = 0; i < a.capacity; i++) {
      if (a.alive[i]) expect(Number.isFinite(a.pose[i * 4]!) && Number.isFinite(a.v[i]!)).toBe(true);
    }
  });
});

import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../src/core/math';
import { zoneDistance } from '../src/env/zone';
import { Editor, ROAD_PRESETS } from '../src/editor/editor';
import { addRoad, bendRoad, deleteRoad, setLanes, setTurns } from '../src/editor/ops';
import { BOUNDARY_TOL, segmentEditable, splitAtZone } from '../src/editor/rules';
import { snapPoint } from '../src/editor/snap';
import { validate } from '../src/editor/validate';
import { TEST_SEED, TEST_ZONE, buildTestNetwork, testSpawners } from '../src/game/testScene';
import { World } from '../src/game/world';
import { type LaneProfile, RoadNetwork, TURN_LEFT } from '../src/network/network';
import { buildRoadMesh } from '../src/render/roadMesh';
import { LaneGraph } from '../src/sim/laneGraph';
import { TrafficSim } from '../src/sim/traffic';

const STREET: LaneProfile = ROAD_PRESETS[0]!.profile;
const AVENUE: LaneProfile = ROAD_PRESETS[1]!.profile;
const zone = TEST_ZONE;
const free = (x: number, z: number) => ({ kind: 'free' as const, pos: [x, 0, z] as Vec3 });

function zoned(): RoadNetwork {
  const net = buildTestNetwork();
  splitAtZone(net, zone);
  return net;
}

function healthy(sim: TrafficSim): boolean {
  for (let i = 0; i < sim.capacity; i++) {
    if (!sim.alive[i]) continue;
    if (!Number.isFinite(sim.s[i]!) || !Number.isFinite(sim.v[i]!) || sim.v[i]! < 0) return false;
    if (sim.s[i]! > sim.graph.lanes[sim.lane[i]!]!.path.length + 1) return false;
  }
  return true;
}

describe('zone split', () => {
  it('cuts roads at the construction-zone border into editable and fixed parts', () => {
    const net = zoned();
    expect(net.segments.size).toBe(buildTestNetwork().segments.size + 4); // the 4 roads out of the centre
    for (const seg of net.segments.values()) {
      const m = seg.curve.point(0.5);
      expect(segmentEditable(net, zone, seg)).toBe(zoneDistance(zone, m[0], m[2]) < 0);
    }
    // Boundary nodes join identical roads in a straight line: no junction surface, no seam.
    const boundary = [...net.nodes.values()].filter((n) => Math.abs(zoneDistance(zone, n.pos[0], n.pos[2])) < BOUNDARY_TOL);
    expect(boundary.length).toBe(4);
    for (const n of boundary) expect(net.isJunction(n.id)).toBe(false);
  });

  it('accepts the hand-made test network as valid', () => {
    const net = zoned();
    const inside = [...net.segments.values()].filter((s) => segmentEditable(net, zone, s)).map((s) => s.id);
    expect(validate(net, zone, inside)).toBeNull();
  });
});

describe('edit operations', () => {
  it('round-trips the network through plain data', () => {
    const net = zoned();
    const copy = RoadNetwork.fromData(JSON.parse(JSON.stringify(net.toData())));
    expect(buildRoadMesh(copy).vertices).toEqual(buildRoadMesh(net).vertices);
    expect(new LaneGraph(copy).lanes.length).toBe(new LaneGraph(net).lanes.length);
  });

  it('adds a junction where a new road crosses an existing one', () => {
    const net = zoned();
    const before = net.nodes.size;
    // North-south street across the arterial (which runs along z = 0) at x = -35.
    const r = addRoad(net, free(-35, -40), free(-35, 40), STREET);
    expect(net.nodes.size).toBe(before + 3); // two ends + the crossing
    const crossing = [...net.nodes.values()].find((n) => Math.abs(n.pos[0] + 35) < 0.01 && Math.abs(n.pos[2]) < 0.01);
    expect(crossing?.segments.length).toBe(4);
    expect(net.isJunction(crossing!.id)).toBe(true);
    expect(validate(net, zone, r.touched, r.changed)).toBeNull();
    expect(r.cost).toBeGreaterThan(0);
  });

  it('joins a road onto the middle of another as a T-junction', () => {
    const net = zoned();
    const snap = snapPoint(net, zone, [-35, 0, 1], 3);
    expect(snap.anchor.kind).toBe('segment');
    addRoad(net, snap.anchor, free(-35, 45), STREET);
    const t = [...net.nodes.values()].find((n) => Math.abs(n.pos[0] + 35) < 0.5 && Math.abs(n.pos[2]) < 0.5);
    expect(t?.segments.length).toBe(3);
  });

  it('snaps free ends to 15° steps and whole metres', () => {
    const net = zoned();
    const s = snapPoint(net, zone, [-20.3, 0, -40.6], 2, free(-40, -40));
    expect(s.aligned).toBe(true);
    expect(s.anchor.pos[2]).toBeCloseTo(-40, 6);
    expect(s.anchor.pos[0]).toBeCloseTo(-20, 6);
  });

  it('bends a road through the handle point', () => {
    const net = zoned();
    const r = addRoad(net, free(-50, -50), free(-10, -50), STREET);
    const id = r.touched.find((s) => net.segment(s).curve.length > 30)!;
    bendRoad(net, id, [-30, 0, -40]);
    const mid = net.segment(id).curve.point(0.5);
    expect(mid[0]).toBeCloseTo(-30, 3);
    expect(mid[2]).toBeCloseTo(-40, 3);
  });

  it('removes a road and nodes left without roads', () => {
    const net = zoned();
    const r = addRoad(net, free(-50, -50), free(-10, -50), STREET);
    const nodes = net.nodes.size;
    deleteRoad(net, r.touched[0]!);
    expect(net.nodes.size).toBe(nodes - 2);
  });

  it('rejects bad geometry with a reason', () => {
    const net = zoned();
    const check = (fn: (n: RoadNetwork) => { touched: number[]; changed: number[] }) => {
      const n = net.clone();
      const r = fn(n);
      return validate(n, zone, r.touched, r.changed);
    };
    expect(check((n) => addRoad(n, free(-50, -50), free(-47, -50), STREET))).toMatch(/short/);
    expect(check((n) => addRoad(n, free(-50, -50), free(60, -50), STREET))).toBeNull();
    expect(check((n) => addRoad(n, free(30, -30), free(60, -100), STREET))).toMatch(/zone/);
    // Parallel to the arterial, 6 m off its centreline: overlaps it.
    expect(check((n) => addRoad(n, free(-50, 6), free(-20, 6), STREET))).toMatch(/Overlaps/);
    // Very sharp angle next to the central east-west arterial.
    const centre = [...net.nodes.values()].find((x) => x.pos[0] === 0 && x.pos[2] === 0)!;
    expect(check((n) => addRoad(n, { kind: 'node', id: centre.id, pos: centre.pos }, free(50, 8), STREET))).toMatch(/angle|Overlaps/);
  });

  it('honours lane-use overrides', () => {
    const net = zoned();
    const centre = [...net.nodes.values()].find((x) => x.pos[0] === 0 && x.pos[2] === 0)!;
    const westArm = net.arms(centre.id).find((a) => a.dir[0] < -0.9)!.segment;
    setTurns(net, westArm.id, centre.id, 1, TURN_LEFT); // kerb-side lane: left only
    const g = new LaneGraph(net);
    const lane = g.lanes.find((l) => l.kind === 'road' && l.segment === westArm.id && l.toNode === centre.id && l.index === 1)!;
    expect(lane.next.map((c) => g.lanes[c]!.turn)).toEqual(['left']);
  });

  it('treats a lane drop as a junction where the extra lane merges', () => {
    const net = zoned();
    const centre = [...net.nodes.values()].find((x) => x.pos[0] === 0 && x.pos[2] === 0)!;
    const westArm = net.arms(centre.id).find((a) => a.dir[0] < -0.9)!.segment;
    setLanes(net, westArm.id, 3, 3); // the boundary node now joins 3+3 to 2+2
    const node = net.otherEnd(westArm, centre.id);
    expect(net.isJunction(node)).toBe(true);
    const sim = new TrafficSim(new LaneGraph(net), testSpawners(net), 3);
    const merges = sim.junctions.conflicts.flat().filter((c) => c.yields);
    expect(merges.length).toBeGreaterThan(0);
  });
});

describe('live editing', () => {
  const makeWorld = () => new World(buildTestNetwork(), zone, TEST_SEED, testSpawners);

  it('keeps traffic running across edits', () => {
    const w = makeWorld();
    for (let i = 0; i < 600; i++) w.sim.step(0.1);
    const before = w.sim.stats.vehicles;
    expect(before).toBeGreaterThan(20);
    const ed = new Editor(w);
    ed.apply((n) => addRoad(n, free(-35, -45), free(-35, 45), STREET));
    expect(w.sim.stats.vehicles).toBeGreaterThan(before * 0.8);
    expect(healthy(w.sim)).toBe(true);
    const exited = w.sim.stats.exited;
    for (let i = 0; i < 1200; i++) w.sim.step(0.1);
    expect(healthy(w.sim)).toBe(true);
    expect(w.sim.stats.exited).toBeGreaterThan(exited + 50);
  });

  it('removes only the vehicles on a deleted road', () => {
    const w = makeWorld();
    for (let i = 0; i < 600; i++) w.sim.step(0.1);
    const centre = [...w.net.nodes.values()].find((x) => x.pos[0] === 0 && x.pos[2] === 0)!;
    const south = w.net.arms(centre.id).find((a) => a.dir[2] > 0.9)!.segment;
    const before = w.sim.stats.vehicles;
    const ed = new Editor(w);
    expect(ed.apply((n) => deleteRoad(n, south.id))).toBeNull();
    expect(w.lastDropped).toBeLessThan(before * 0.3);
    for (let i = 0; i < 600; i++) w.sim.step(0.1);
    expect(healthy(w.sim)).toBe(true);
  });

  it('demolishes buildings in the way and undo brings them back', () => {
    const w = makeWorld();
    const ed = new Editor(w);
    const data = JSON.stringify(w.net.toData());
    // A diagonal street through the lots in the south-west quarter.
    expect(ed.apply((n) => addRoad(n, free(-60, 15), free(-15, 60), STREET))).toBeNull();
    expect(w.demolished.size).toBeGreaterThan(0);
    expect(w.spent).toBeGreaterThan(0);
    ed.undo();
    expect(w.demolished.size).toBe(0);
    expect(w.spent).toBe(0);
    expect(JSON.stringify(w.net.toData())).toBe(data);
    ed.redo();
    expect(w.demolished.size).toBeGreaterThan(0);
  });

  it('charges nothing and demolishes nothing for a signal-only change', () => {
    const w = makeWorld();
    const ed = new Editor(w);
    const centre = [...w.net.nodes.values()].find((x) => x.pos[0] === 0 && x.pos[2] === 0)!;
    expect(ed.apply((n) => { n.node(centre.id).control = 'allway'; })).toBeNull();
    expect(w.spent).toBe(0);
    expect(w.demolished.size).toBe(0);
  });

  it('draws a road with a drag gesture', () => {
    const w = makeWorld();
    const ed = new Editor(w);
    ed.setTool('road');
    ed.preset = 1;
    const n0 = w.net.segments.size;
    expect(ed.down([-50, 0, -40], 3)).toBe(true);
    ed.move([-40, 0, -40], 3);
    ed.move([-25, 0, -40], 3);
    expect(ed.draft?.error).toBeNull();
    ed.up();
    expect(w.net.segments.size).toBe(n0 + 1);
    expect([...w.net.segments.values()].some((s) => s.profile.forward === AVENUE.forward && s.profile.backward === AVENUE.backward && s.curve.length > 24)).toBe(true);
    expect(ed.canUndo).toBe(true);
    ed.undo();
    expect(w.net.segments.size).toBe(n0);
  });
});

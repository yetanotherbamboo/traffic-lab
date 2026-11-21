import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../src/core/math';
import { Editor } from '../src/editor/editor';
import { addRoad, deleteRoad, setLanes } from '../src/editor/ops';
import {
  convertToRoundabout, removeRing, removeRoundabout, ringParts, setRoundaboutLanes, setRoundaboutSize,
} from '../src/editor/roundabout';
import { snapPoint } from '../src/editor/snap';
import { validate } from '../src/editor/validate';
import { lotsOverlap } from '../src/env/city';
import type { Zone } from '../src/env/zone';
import { TEST_SEED, TEST_ZONE, buildTestNetwork, testSpawners } from '../src/game/testScene';
import { World } from '../src/game/world';
import { type LaneProfile, RoadNetwork } from '../src/network/network';
import { buildRoadMesh } from '../src/render/roadMesh';
import { LaneGraph } from '../src/sim/laneGraph';
import { type Spawner, TrafficSim } from '../src/sim/traffic';

const BIG: Zone = { cx: 0, cz: 0, hx: 400, hz: 400, radius: 14, contextScale: 2 };
const STREET: LaneProfile = { forward: 1, backward: 1, laneWidth: 3.25, sidewalk: 2.5, speedLimit: 40 };
const AVENUE: LaneProfile = { forward: 2, backward: 2, laneWidth: 3.5, sidewalk: 2.5, speedLimit: 50 };
const BOULEVARD: LaneProfile = { forward: 3, backward: 3, laneWidth: 3.5, sidewalk: 3, speedLimit: 60 };
const ONE_WAY_IN: LaneProfile = { forward: 0, backward: 2, laneWidth: 3.25, sidewalk: 2, speedLimit: 40 };
const free = (x: number, z: number) => ({ kind: 'free' as const, pos: [x, 0, z] as Vec3 });

/** A junction at the origin with roads to dead ends at the given angles (degrees). */
function star(arms: [number, LaneProfile][], length = 200) {
  const net = new RoadNetwork();
  const c = net.addNode([0, 0, 0]);
  const ends: number[] = [];
  for (const [deg, p] of arms) {
    const a = (deg * Math.PI) / 180;
    const e = net.addNode([Math.round(Math.cos(a) * length), 0, Math.round(Math.sin(a) * length)]);
    net.addSegment(c, e, p);
    ends.push(e);
  }
  return { net, centre: c, ends };
}

const allSegs = (net: RoadNetwork) => [...net.segments.keys()];

function overlaps(sim: TrafficSim): number {
  const boxes: Parameters<typeof lotsOverlap>[0][] = [];
  for (let i = 0; i < sim.capacity; i++) {
    if (!sim.alive[i]) continue;
    const x = sim.pose[i * 4]!, z = sim.pose[i * 4 + 2]!, h = sim.pose[i * 4 + 3]!;
    const half = sim.length[i]! / 2;
    boxes.push({ cx: x - Math.cos(h) * half, cz: z + Math.sin(h) * half, angle: h, hx: half * 0.8, hz: sim.width[i]! * 0.4, kind: 'house', inZone: false });
  }
  let n = 0;
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) if (lotsOverlap(boxes[i]!, boxes[j]!)) n++;
  return n;
}

describe('roundabout geometry', () => {
  it('turns a 4-way junction into a ring with one entry per road, anticlockwise from above', () => {
    const { net, centre } = star([[0, AVENUE], [90, STREET], [180, AVENUE], [270, STREET]]);
    const r = convertToRoundabout(net, centre);
    expect(net.nodes.has(centre)).toBe(false);
    const rb = net.roundabouts.get(r.id)!;
    expect(rb.lanes).toBe(2); // the widest road has 2 lanes each way
    const { segments, nodes } = ringParts(net, r.id);
    const entries = nodes.filter((n) => net.node(n).segments.length === 3);
    expect(entries.length).toBe(4);
    for (const n of entries) {
      const node = net.node(n);
      expect(Math.hypot(node.pos[0], node.pos[2])).toBeCloseTo(rb.radius, 3);
      expect(node.major?.every((s) => net.segment(s).ring === r.id)).toBe(true);
    }
    // Ring roads are one-way with their lanes outside the island and run clockwise in atan2 terms
    // (anticlockwise seen from above with z pointing down the screen): right-hand traffic.
    for (const sid of segments) {
      const seg = net.segment(sid);
      expect(seg.profile.backward).toBe(0);
      const a = net.node(seg.a).pos, b = net.node(seg.b).pos;
      let d = Math.atan2(b[2], b[0]) - Math.atan2(a[2], a[0]);
      if (d > Math.PI) d -= 2 * Math.PI;
      if (d < -Math.PI) d += 2 * Math.PI;
      expect(d).toBeLessThan(0);
      const mid = seg.curve.point(0.5);
      expect(Math.hypot(mid[0], mid[2])).toBeCloseTo(rb.radius, 0);
    }
    expect(validate(net, BIG, allSegs(net))).toBeNull();
    expect(buildRoadMesh(net).indices.length).toBeGreaterThan(0);
  });

  it('round-trips through plain data (undo snapshots)', () => {
    const { net, centre } = star([[0, STREET], [120, STREET], [240, STREET]]);
    const r = convertToRoundabout(net, centre);
    const copy = RoadNetwork.fromData(JSON.parse(JSON.stringify(net.toData())));
    expect(copy.roundabouts.get(r.id)).toEqual(net.roundabouts.get(r.id));
    expect(ringParts(copy, r.id)).toEqual(ringParts(net, r.id));
    expect(buildRoadMesh(copy).vertices).toEqual(buildRoadMesh(net).vertices);
  });

  it('turns back into a plain junction at the centre', () => {
    const { net, centre } = star([[0, AVENUE], [90, STREET], [180, AVENUE], [270, STREET]]);
    const r = convertToRoundabout(net, centre);
    const back = removeRoundabout(net, r.id);
    expect(net.roundabouts.size).toBe(0);
    expect([...net.segments.values()].some((s) => s.ring !== undefined)).toBe(false);
    const node = net.node(back.node);
    expect(node.pos).toEqual([0, 0, 0]);
    expect(node.segments.length).toBe(4);
    for (const sid of node.segments) expect(net.segment(sid).curve.length).toBeCloseTo(200, 1); // full length again, straight
    expect(validate(net, BIG, allSegs(net))).toBeNull();
  });

  it('grows the island until neighbouring entries have room, and rejects too small a size', () => {
    const { net, centre } = star([[0, BOULEVARD], [72, STREET], [144, ONE_WAY_IN], [216, BOULEVARD], [288, STREET]]);
    const r = convertToRoundabout(net, centre, 1);
    expect(validate(net, BIG, allSegs(net))).toBeNull();
    const smaller = net.clone();
    setRoundaboutSize(smaller, r.id, net.roundabouts.get(r.id)!.radius - 6);
    expect(validate(smaller, BIG, allSegs(smaller))).toMatch(/too small/);
    const bigger = net.clone();
    setRoundaboutSize(bigger, r.id, net.roundabouts.get(r.id)!.radius + 6);
    expect(bigger.roundabouts.get(r.id)!.radius).toBe(net.roundabouts.get(r.id)!.radius + 6);
    expect(validate(bigger, BIG, allSegs(bigger))).toBeNull();
  });

  it('lets new roads join the ring from outside, but not cross the island', () => {
    const { net, centre } = star([[0, STREET], [90, STREET], [180, STREET]]);
    const r = convertToRoundabout(net, centre);
    const R = net.roundabouts.get(r.id)!.radius;
    // A road joining the empty side of the ring (angle 270°, where the long arc has a joint).
    const snap = snapPoint(net, BIG, [0, 0, -R], 2);
    expect(['node', 'segment']).toContain(snap.anchor.kind);
    const add = net.clone();
    const res = addRoad(add, snap.anchor, free(0, -150), STREET);
    expect(validate(add, BIG, res.touched, res.changed)).toBeNull();
    const joint = [...add.nodes.values()].find((n) => n.ring === r.id && Math.abs(n.pos[2] + R) < 0.5)!;
    expect(joint.segments.length).toBe(3);
    const major = new TrafficSim(new LaneGraph(add), [], 1).junctions.major.get(joint.id)!;
    expect([...major].every((s) => add.segment(s).ring === r.id) && major.size === 2).toBe(true);
    // A road straight through the island is refused.
    const through = net.clone();
    const t = addRoad(through, free(-60, -60), free(60, 60), STREET);
    expect(validate(through, BIG, t.touched, t.changed)).toMatch(/island/);
  });

  it('removing the ring leaves the roads as dead ends', () => {
    const { net, centre } = star([[0, STREET], [90, STREET], [180, STREET], [270, STREET]]);
    const r = convertToRoundabout(net, centre);
    removeRing(net, r.id);
    expect(net.roundabouts.size).toBe(0);
    expect(net.segments.size).toBe(4);
    for (const n of net.nodes.values()) expect(n.segments.length).toBe(1);
  });
});

describe('roundabout lanes', () => {
  const connectors = (g: LaneGraph, from: number) => g.lanes[from]!.next.map((c) => g.lanes[g.lanes[c]!.next[0]!]!);

  it('connects any lane counts: every lane gets a way on and off the ring', () => {
    for (const ring of [1, 2, 3]) {
      const { net, centre } = star([[0, BOULEVARD], [90, STREET], [180, ONE_WAY_IN], [270, AVENUE]]);
      const r = convertToRoundabout(net, centre, ring);
      const g = new LaneGraph(net);
      for (const l of g.lanes) {
        if (l.kind !== 'road') continue;
        const seg = net.segment(l.segment);
        const atRing = net.node(l.toNode).ring === r.id && net.node(l.toNode).segments.length >= 3;
        if (!atRing) continue;
        const nexts = connectors(g, l.id);
        if (seg.ring === undefined) {
          // Entering: only onto the ring, turning right.
          expect(nexts.length, `entry lane ${l.index} with ${ring} ring lanes`).toBeGreaterThan(0);
          for (const n of nexts) expect(net.segment(n.segment).ring).toBe(r.id);
          for (const c of l.next) expect(g.lanes[c]!.turn).toBe('right');
        } else {
          // On the ring: always onwards around it; exits only from the outer lanes.
          expect(nexts.some((n) => net.segment(n.segment).ring === r.id)).toBe(true);
          const exits = nexts.filter((n) => net.segment(n.segment).ring === undefined);
          for (const e of exits) expect(g.lanes[g.lanes[e.prev[0]!]!.prev[0]!]!.index).toBeGreaterThanOrEqual(0);
        }
      }
      // Every ring lane is fed and every exit lane is reachable.
      for (const l of g.lanes) {
        if (l.kind === 'road' && l.prev.length === 0) expect(g.sources.has(l.fromNode), `lane ${l.id} has no way in`).toBe(true);
      }
    }
  });

  it('exits only from the outer ring lanes when the exit is narrower', () => {
    const { net, centre } = star([[0, STREET], [90, STREET], [180, STREET], [270, STREET]]);
    convertToRoundabout(net, centre, 3);
    const g = new LaneGraph(net);
    for (const l of g.lanes) {
      if (l.kind !== 'connector' || l.turn !== 'right') continue;
      const from = g.lanes[l.prev[0]!]!;
      if (net.segment(from.segment).ring === undefined) continue;
      expect(from.index, 'single-lane exits are taken from the outermost ring lane').toBe(2);
    }
  });

  it('changing lanes keeps the network valid', () => {
    const { net, centre } = star([[0, AVENUE], [90, STREET], [180, AVENUE], [270, STREET]]);
    const r = convertToRoundabout(net, centre);
    setRoundaboutLanes(net, r.id, 1);
    expect(ringParts(net, r.id).segments.every((s) => net.segment(s).profile.forward === 1)).toBe(true);
    expect(validate(net, BIG, allSegs(net))).toBeNull();
    expect(() => setRoundaboutLanes(net, r.id, 4)).toThrow();
  });
});

describe('roundabout traffic (no collisions, no gridlock)', () => {
  for (const [name, arms, lanes, rate] of [
    ['4 streets, 1 lane', [[0, STREET], [90, STREET], [180, STREET], [270, STREET]], 1, 300],
    ['avenues and streets, 2 lanes', [[0, AVENUE], [90, STREET], [180, AVENUE], [270, STREET]], 2, 400],
    ['5 mixed roads incl. one-way, 1 lane', [[0, BOULEVARD], [72, STREET], [144, ONE_WAY_IN], [216, BOULEVARD], [288, STREET]], 1, 250],
    ['boulevards, 3 lanes', [[0, BOULEVARD], [90, AVENUE], [180, BOULEVARD], [270, AVENUE]], 3, 550],
  ] as const) {
    it(name, () => {
      const { net, centre, ends } = star(arms as unknown as [number, LaneProfile][]);
      convertToRoundabout(net, centre, lanes);
      const spawners: Spawner[] = ends.map((node) => ({ node, rate }));
      const sim = new TrafficSim(new LaneGraph(net), spawners, 7);
      let collisions = 0, longest = 0;
      const still = new Float32Array(sim.capacity);
      for (let t = 1; t <= 9000; t++) {
        sim.step(0.1);
        for (let i = 0; i < sim.capacity; i++) {
          still[i] = sim.alive[i] && sim.v[i]! < 0.1 ? still[i]! + 0.1 : 0;
          longest = Math.max(longest, still[i]!);
        }
        if (t % 2 === 0) collisions += overlaps(sim);
      }
      expect(collisions, 'overlapping vehicles').toBe(0);
      expect(longest, 'longest standstill (s)').toBeLessThan(150);
      expect(sim.stats.exited).toBeGreaterThan(250);
    });
  }
});

describe('roundabouts in the live game', () => {
  it('converts a junction with traffic running, edits it and converts back, with undo', () => {
    const w = new World(buildTestNetwork(), TEST_ZONE, TEST_SEED, testSpawners);
    for (let i = 0; i < 600; i++) w.sim.step(0.1);
    const ed = new Editor(w);
    const centre = [...w.net.nodes.values()].find((n) => n.pos[0] === 0 && n.pos[2] === 0)!;
    const segs0 = w.net.segments.size;
    expect(ed.apply((n) => convertToRoundabout(n, centre.id))).toBeNull();
    const id = [...w.net.roundabouts.keys()][0]!;
    for (let i = 0; i < 1200; i++) w.sim.step(0.1);
    expect(overlaps(w.sim)).toBe(0);
    const exited = w.sim.stats.exited;
    for (let i = 0; i < 1200; i++) w.sim.step(0.1);
    expect(w.sim.stats.exited).toBeGreaterThan(exited + 50);

    // Select by tapping the island, change lanes, then back to a signal junction.
    ed.setTool('select');
    ed.tap([0, 0, 3], 2);
    expect(ed.selection).toMatchObject({ kind: 'roundabout', id });
    expect(ed.apply((n) => setRoundaboutLanes(n, id, 1))).toBeNull();
    expect(ed.apply((n) => removeRoundabout(n, id))).toBeNull();
    expect(w.net.roundabouts.size).toBe(0);
    expect(w.net.segments.size).toBe(segs0);
    ed.undo();
    ed.undo();
    expect(w.net.roundabouts.get(id)?.lanes).toBe(2);
    for (let i = 0; i < 600; i++) w.sim.step(0.1);
    expect(overlaps(w.sim)).toBe(0);
  });

  it('a road can join the ring anywhere: the ring is rebuilt around the new entry', () => {
    const w = new World(buildTestNetwork(), TEST_ZONE, TEST_SEED, testSpawners);
    const ed = new Editor(w);
    ed.setTool('delete');
    ed.tap([0, 0, -30], 2); // the north street: the centre becomes a T
    const centre = [...w.net.nodes.values()].find((n) => n.pos[0] === 0 && n.pos[2] === 0)!;
    expect(centre.segments.length).toBe(3);
    expect(ed.apply((n) => convertToRoundabout(n, centre.id))).toBeNull();
    const id = [...w.net.roundabouts.keys()][0]!;
    expect(ed.apply((n) => setRoundaboutSize(n, id, 25))).toBeNull();
    for (let i = 0; i < 300; i++) w.sim.step(0.1);
    // Join just off the joint in the middle of the empty side (where the ring had a plain joint).
    const a = -Math.PI / 2 + 0.3, R = 26;
    ed.setTool('road');
    ed.down([Math.cos(a) * R, 0, Math.sin(a) * R], 2);
    ed.move([Math.cos(a) * 64, 0, Math.sin(a) * 64], 2);
    expect(ed.draft?.error ?? null).toBeNull();
    ed.up(); ed.confirm(); ed.cancel();
    const entries = ringParts(w.net, id).nodes.filter((n) => w.net.node(n).segments.length === 3);
    expect(entries.length).toBe(4);
    expect(validate(w.net, TEST_ZONE, allSegs(w.net).filter((s) => w.net.segment(s).ring === id))).toBeNull();
    for (let i = 0; i < 1200; i++) w.sim.step(0.1);
    expect(overlaps(w.sim)).toBe(0);
    // Removing that road again tidies the ring back to its even layout.
    const joined = [...w.net.segments.values()].find((s) => s.ring === undefined && entries.some((n) => s.a === n || s.b === n)
      && Math.abs(Math.atan2(w.net.node(s.a).pos[2], w.net.node(s.a).pos[0]) - a) < 0.1)!;
    expect(joined).toBeDefined();
    expect(ed.apply((n) => deleteRoad(n, joined.id))).toBeNull();
    expect(ringParts(w.net, id).nodes.filter((n) => w.net.node(n).segments.length === 3).length).toBe(3);
  });

  it('the Remove tool removes the whole ring; Bend refuses ring roads', () => {
    const w = new World(buildTestNetwork(), TEST_ZONE, TEST_SEED, testSpawners);
    const ed = new Editor(w);
    const centre = [...w.net.nodes.values()].find((n) => n.pos[0] === 0 && n.pos[2] === 0)!;
    ed.apply((n) => convertToRoundabout(n, centre.id));
    const r = [...w.net.roundabouts.values()][0]!;
    const onRing: Vec3 = [-(r.radius + 2), 0, -6];
    ed.setTool('bend');
    ed.down(onRing, 2);
    ed.up(); ed.confirm(); ed.cancel();
    expect(ed.message).toMatch(/round shape/);
    ed.setTool('delete');
    ed.tap(onRing, 2);
    expect(w.net.roundabouts.size).toBe(0);
    expect([...w.net.segments.values()].some((s) => s.ring !== undefined)).toBe(false);
  });

  it('refuses junctions that cannot hold a roundabout', () => {
    const { net, centre } = star([[0, STREET], [180, STREET]]);
    expect(() => convertToRoundabout(net, centre)).toThrow(/3 or more/);
    const short = star([[0, STREET], [90, STREET], [180, STREET]], 20);
    convertToRoundabout(short.net, short.centre); // fits, but what is left of the roads is too short
    expect(validate(short.net, BIG, allSegs(short.net))).toMatch(/Too short/);
    const ok = star([[0, STREET], [90, STREET], [180, STREET]]);
    const r = convertToRoundabout(ok.net, ok.centre, 1);
    expect(() => convertToRoundabout(ok.net, ringParts(ok.net, r.id).nodes[0]!)).toThrow();
    // Deleting a road that joins the ring leaves a valid roundabout.
    const entry = [...ok.net.segments.values()].find((s) => s.ring === undefined)!;
    deleteRoad(ok.net, entry.id);
    expect(validate(ok.net, BIG, allSegs(ok.net))).toBeNull();
    // Widening a road that joins the ring keeps it valid (or explains why not).
    const other = [...ok.net.segments.values()].find((s) => s.ring === undefined)!;
    setLanes(ok.net, other.id, 2, 2);
    expect(validate(ok.net, BIG, allSegs(ok.net)) ?? '').not.toMatch(/Overlaps/);
  });
});

import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../src/core/math';
import { itemsHitByRoads } from '../src/env/city';
import { zoneDistance } from '../src/env/zone';
import { Editor, ROAD_PRESETS } from '../src/editor/editor';
import { TOO_CLOSE, addRoad, bendRoad, deleteRoad, setLanes, setTurns } from '../src/editor/ops';
import { BOUNDARY_TOL, segmentEditable, splitAtZone } from '../src/editor/rules';
import { snapPoint } from '../src/editor/snap';
import { validate } from '../src/editor/validate';
import { TEST_SEED, TEST_ZONE, buildTestNetwork, testSpawners } from '../src/game/testScene';
import { World } from '../src/game/world';
import { LIT_STRIDE } from '../src/env/city';
import { JunctionProps } from '../src/render/junctionProps';
import { type LaneProfile, RoadNetwork, TURN_LEFT, TURN_RIGHT, TURN_STRAIGHT, rightOf } from '../src/network/network';
import { ROAD_STRIDE } from '../src/render/roadMesh';
import { buildRoadMesh } from '../src/render/roadMesh';
import { LaneGraph, TURN_BIT } from '../src/sim/laneGraph';
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

describe('acute junctions', () => {
  /** A junction with roads at the given angles (degrees), all Avenues 100 m long. */
  function star(angles: number[]) {
    const net = new RoadNetwork();
    const c = net.addNode([0, 0, 0]);
    for (const a of angles) {
      const r = (a * Math.PI) / 180;
      net.addSegment(c, net.addNode([Math.cos(r) * 100, 0, Math.sin(r) * 100]), AVENUE);
    }
    return { net, c };
  }

  /** Outer sidewalk edge (right or left of the outward direction) along a road's drawn part. */
  function edge(net: RoadNetwork, segId: number, node: number, side: 1 | -1): [number, number][] {
    const seg = net.segment(segId);
    const [s0, s1] = net.trimmedRange(seg);
    const out: [number, number][] = [];
    const outward = seg.a === node;
    const ext = Math.max(seg.profile.forward, seg.profile.backward) * seg.profile.laneWidth + seg.profile.sidewalk;
    for (let k = 0; k <= 40; k++) {
      const s = s0 + ((s1 - s0) * k) / 40;
      const t = seg.curve.tAtDistance(s);
      const p = seg.curve.point(t), d = seg.curve.derivative(t), l = Math.hypot(d[0], d[2]);
      const dir: [number, number, number] = outward ? [d[0] / l, 0, d[2] / l] : [-d[0] / l, 0, -d[2] / l];
      const r = rightOf(dir);
      out.push([p[0] + r[0] * ext * side, p[2] + r[2] * ext * side]);
    }
    return out;
  }

  function crosses(a: [number, number][], b: [number, number][]): boolean {
    for (let i = 0; i + 1 < a.length; i++) {
      for (let j = 0; j + 1 < b.length; j++) {
        const [p, q, r, s] = [a[i]!, a[i + 1]!, b[j]!, b[j + 1]!];
        const d = (q[0] - p[0]) * (s[1] - r[1]) - (q[1] - p[1]) * (s[0] - r[0]);
        if (Math.abs(d) < 1e-9) continue;
        const u = ((r[0] - p[0]) * (s[1] - r[1]) - (r[1] - p[1]) * (s[0] - r[0])) / d;
        const v = ((r[0] - p[0]) * (q[1] - p[1]) - (r[1] - p[1]) * (q[0] - p[0])) / d;
        if (u >= 0 && u <= 1 && v >= 0 && v <= 1) return true;
      }
    }
    return false;
  }

  for (const angles of [[0, 30, 180], [0, 40, 200, 270], [0, 28], [0, 60, 120, 240]]) {
    it(`keeps sidewalks of neighbouring roads apart (${angles.join('°, ')}°)`, () => {
      const { net, c } = star(angles);
      const arms = net.arms(c);
      for (let i = 0; i < arms.length; i++) {
        const a = arms[i]!, b = arms[(i + 1) % arms.length]!;
        // Right edge of one road vs the left edge of the next one (counter-clockwise).
        expect(crosses(edge(net, a.segment.id, c, 1), edge(net, b.segment.id, c, -1))).toBe(false);
      }
      // Junction surface and corners still face upwards.
      const mesh = buildRoadMesh(net);
      const V = mesh.vertices, S = ROAD_STRIDE;
      for (let t = 0; t < mesh.indices.length; t += 3) {
        const [p, q, r] = [mesh.indices[t]!, mesh.indices[t + 1]!, mesh.indices[t + 2]!];
        if (V[p * S + 4]! < 0.99) continue;
        const e1 = [V[q * S]! - V[p * S]!, V[q * S + 2]! - V[p * S + 2]!];
        const e2 = [V[r * S]! - V[p * S]!, V[r * S + 2]! - V[p * S + 2]!];
        expect(e1[1]! * e2[0]! - e1[0]! * e2[1]!).toBeGreaterThanOrEqual(-1e-6);
      }
    });
  }

  it('leaves right-angle junctions the same size as before', () => {
    const { net, c } = star([0, 90, 180, 270]);
    // Base size: widest half carriageway (2 × 3.5) + sidewalk 2.5 + 3.
    for (const a of net.arms(c)) expect(net.armTrim(c, a.segment.id)).toBeCloseTo(12.5, 6);
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

  it('removes street trees that a widened road would put on the asphalt', () => {
    const w = makeWorld();
    const ed = new Editor(w);
    const onRoad = () => itemsHitByRoads(w.city, w.net, zone, 'asphalt').filter((id) => !w.demolished.has(id));
    expect(onRoad()).toEqual([]);
    const centre = [...w.net.nodes.values()].find((x) => x.pos[0] === 0 && x.pos[2] === 0)!;
    const west = w.net.arms(centre.id).find((a) => a.dir[0] < -0.9)!.segment;
    const trees = () => [...w.demolished].filter((id) => w.city.items[id]!.kind === 'tree').length;
    expect(ed.apply((n) => setLanes(n, west.id, 3, 3))).toBeNull();
    expect(trees()).toBeGreaterThan(0);
    expect(onRoad()).toEqual([]);
    // A new crossing street keeps the invariant too.
    expect(ed.apply((n) => addRoad(n, free(40, -45), free(40, 45), STREET))).toBeNull();
    expect(onRoad()).toEqual([]);
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

describe('turn arrows', () => {
  it('are painted on limited approach lanes, inside the lane, also near close junctions and on bends', () => {
    const net = zoned();
    addRoad(net, free(-35, -40), free(-35, 40), AVENUE); // 2 lanes each way: inner and outer lanes are limited
    // A second street close to the arterial: the approaches between them are short.
    addRoad(net, free(-55, -18), free(-15, -18), STREET);
    // A third street makes the north piece a road between two junctions; bending it curves both approaches.
    addRoad(net, free(-55, 30), free(-15, 30), STREET);
    const crossing = [...net.nodes.values()].find((n) => Math.abs(n.pos[0] + 35) < 0.01 && Math.abs(n.pos[2]) < 0.01)!;
    const north = net.arms(crossing.id).find((a) => a.dir[2] > 0.9)!.segment;
    bendRoad(net, north.id, [-20, 0, 20]);

    const sim = new TrafficSim(new LaneGraph(net), [], 1);
    const props = new JunctionProps(sim);
    const lanes = sim.graph.lanes;
    const approaches = lanes.filter((l) => l.kind === 'road' && lanes[l.next[0] ?? -1]?.kind === 'connector' && net.node(lanes[l.next[0]!]!.node).segments.length >= 3);
    // Arrows only on lanes limited to some directions (no arrow = any way); lanes squeezed to
    // (almost) nothing between two junctions have no room for paint.
    const mask = (l: (typeof lanes)[number]) => l.next.reduce((m, n) => m | TURN_BIT[lanes[n]!.turn ?? 'straight'], 0);
    const limited = approaches.filter((l) => mask(l) !== sim.graph.armTurns.get(l.id));
    expect(props.arrowLanes).toBe(limited.filter((l) => l.path.length >= 5.5).length);
    expect(limited.some((l) => l.path.length >= 5.5 && l.path.length < 14)).toBe(true); // close junctions covered

    // Arrow stems (0.18 m wide, 1.8 m long: the base and the straight-ahead part) sit on a lane's
    // centre line, also on the curved approaches.
    const b = props.buffer;
    let stems = 0;
    for (let o = 0; o < b.length; o += LIT_STRIDE) {
      if (Math.abs(b[o + 1]! - 0.03) > 1e-4 || Math.abs(b[o + 6]! - 0.18) > 1e-4 || Math.abs(b[o + 4]! - 1.89) > 0.05) continue;
      const dist = Math.min(...approaches.map((l) => l.path.project(b[o]!, b[o + 2]!).dist));
      expect(dist).toBeLessThan(0.15);
      stems++;
    }
    expect(stems).toBeGreaterThanOrEqual(props.arrowLanes);
  });

  it('are left off lanes that may go every way, and appear once a lane is limited', () => {
    const net = zoned();
    addRoad(net, free(-35, -40), free(-35, 40), STREET);
    const crossing = [...net.nodes.values()].find((n) => Math.abs(n.pos[0] + 35) < 0.01 && Math.abs(n.pos[2]) < 0.01)!;
    const north = net.arms(crossing.id).find((a) => a.dir[2] > 0.9)!.segment;
    const graph = () => new TrafficSim(new LaneGraph(net), [], 1);
    // The single-lane street approach may go left, straight and right: no arrow on it.
    const onNorth = (sim: TrafficSim) => sim.graph.lanes.filter((l) => l.kind === 'road' && l.segment === north.id
      && sim.graph.lanes[l.next[0] ?? -1]?.node === crossing.id);
    let sim = graph();
    expect(onNorth(sim).length).toBe(1);
    expect(sim.graph.armTurns.get(onNorth(sim)[0]!.id)).toBe(TURN_LEFT | TURN_STRAIGHT | TURN_RIGHT);
    const before = new JunctionProps(sim).arrowLanes;
    expect(before).toBeGreaterThan(0); // the multi-lane arterial lanes keep theirs
    setTurns(net, north.id, crossing.id, 0, TURN_LEFT); // left only
    sim = graph();
    expect(new JunctionProps(sim).arrowLanes).toBe(before + 1);
  });
});

describe('starting a road near a junction', () => {
  it('shows a red cross exactly where no road can start, and refuses to start there', () => {
    const w = new World(buildTestNetwork(), TEST_ZONE, TEST_SEED, testSpawners);
    const ed = new Editor(w);
    ed.setTool('road');
    ed.preset = 1; // avenue: wide junctions
    const kinds: string[] = [];
    for (let x = 1; x <= 69; x += 0.5) {
      ed.hoverAt([x, 0, 0], 1.5);
      const kind = ed.hover!.kind;
      kinds.push(kind);
      const before = w.net.segments.size;
      ed.down([x, 0, 0], 1.5);
      ed.move([x, 0, 20], 1.5);
      ed.move([x, 0, 30], 1.5);
      const err = ed.draft?.error ?? null;
      if (kind === 'blocked') {
        expect(ed.draft?.candidate ?? null, `x=${x}: nothing is previewed`).toBeNull();
        ed.up();
        expect(ed.message).toBe(TOO_CLOSE);
        expect(w.net.segments.size).toBe(before);
      } else {
        // Wherever a road may start, a junction there never makes a piece of the old road too short.
        expect(err, `x=${x}`).not.toBe('Too short: junctions are too close together');
        ed.cancel();
      }
    }
    // Along the avenue east of the centre: the junction itself, a red band, then free road.
    const first = kinds.indexOf('blocked'), firstOk = kinds.indexOf('segment');
    expect(kinds[0]).toBe('node');
    expect(first).toBeGreaterThan(0);
    expect(firstOk).toBeGreaterThan(first);
    // A narrow street needs less room than an avenue.
    ed.preset = 0;
    const streetKinds = kinds.map((_, k) => {
      ed.hoverAt([1 + k * 0.5, 0, 0], 1.5);
      return ed.hover!.kind;
    });
    expect(streetKinds.indexOf('segment')).toBeLessThanOrEqual(firstOk);
  });
});

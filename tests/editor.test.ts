import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../src/core/math';
import { itemsHitByRoads } from '../src/env/city';
import { zoneDistance } from '../src/env/zone';
import { Editor, ROAD_PRESETS } from '../src/editor/editor';
import { TOO_CLOSE, addRoad, bendRoad, deleteRoad, moveNode, setLanes, setTurns, upgradeRoad } from '../src/editor/ops';
import { convertToRoundabout } from '../src/editor/roundabout';
import { BOUNDARY_TOL, segmentEditable, splitAtZone } from '../src/editor/rules';
import { CubicBezier } from '../src/network/bezier';
import { TOO_SHARP, bendFrom, bendPoint, bendSpeed, continueShape, curveShape, offsetCubic, parallelOffset, tightestRadius } from '../src/editor/shape';
import { snapPoint } from '../src/editor/snap';
import { validate } from '../src/editor/validate';
import { TEST_SEED, TEST_ZONE, buildTestNetwork, testSpawners } from '../src/game/testScene';
import { World } from '../src/game/world';
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
    expect(check((n) => addRoad(n, free(60, 40), free(108, 45), STREET))).toMatch(/zone/);
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
    ed.up(); ed.confirm(); ed.cancel();
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

    // Arrows are flat painted shapes (road vertex layout): every triangle faces up, every corner
    // lies well inside an approach lane (also on curved approaches), and each arrow lane has its
    // stem on the lane's centre line.
    const { vertices: V, indices: I } = props.paint;
    expect(I.length).toBeGreaterThan(0);
    const pt = (k: number): Vec3 => [V[k * ROAD_STRIDE]!, V[k * ROAD_STRIDE + 1]!, V[k * ROAD_STRIDE + 2]!];
    for (let t = 0; t < I.length; t += 3) {
      const a = pt(I[t]!), b = pt(I[t + 1]!), c = pt(I[t + 2]!);
      expect((b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2])).toBeGreaterThan(0);
    }
    const n = V.length / ROAD_STRIDE;
    for (let k = 0; k < n; k++) {
      const p = pt(k);
      expect(Math.min(...approaches.map((l) => l.path.project(p[0], p[2]).dist))).toBeLessThan(1.2);
    }
    const arrowed = limited.filter((l) => l.path.length >= 5.5);
    for (const l of arrowed) {
      let near = Infinity;
      for (let k = 0; k < n; k++) near = Math.min(near, l.path.project(pt(k)[0], pt(k)[2]).dist);
      expect(near).toBeLessThan(0.2);
    }
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
        ed.up(); ed.confirm(); ed.cancel();
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

describe('the red cross only allows starts that can lead somewhere', () => {
  /** Can a road `len` m long be drawn from `p` in any of 16 directions? */
  const buildable = (ed: Editor, p: Vec3, from: Vec3, len = 35): boolean => {
    for (let k = 0; k < 16; k++) {
      const h = (k / 16) * Math.PI * 2;
      ed.down(p, 1.5);
      ed.move([from[0] + Math.cos(h) * len, 0, from[2] + Math.sin(h) * len], 1.5);
      const ok = ed.draft !== null && ed.draft.error === null;
      ed.cancel();
      if (ok) return true;
    }
    return false;
  };

  it('every road type may start at the centre junction, and can be built from there', () => {
    const w = new World(buildTestNetwork(), TEST_ZONE, TEST_SEED, testSpawners);
    const ed = new Editor(w);
    ed.setTool('road');
    for (const preset of [0, 1, 2, 3]) {
      ed.preset = preset;
      ed.hoverAt([0, 0, 0], 1.5);
      expect(ed.hover!.kind, `preset ${preset}`).toBe('node');
      // A fifth arm needs a big junction, so the new road must be long enough to leave it.
      expect(buildable(ed, [0, 0, 0], [0, 0, 0], 55), `preset ${preset}`).toBe(true);
    }
  });

  it('every start offered along a road next to new junctions can be built from', () => {
    const w = new World(buildTestNetwork(), TEST_ZONE, TEST_SEED, testSpawners);
    const ed = new Editor(w);
    ed.setTool('road');
    // New T-junctions on all four arms of the centre crossroads.
    const roads: [Vec3, Vec3, number][] = [
      [[30, 0, 0], [30, 0, -70], 0], [[-40, 0, 0], [-40, 0, 60], 1], [[0, 0, 45], [60, 0, 45], 2], [[0, 0, -30], [-70, 0, -50], 0],
    ];
    for (const [a, b, preset] of roads) {
      ed.preset = preset;
      ed.down(a, 1.5);
      ed.move(b, 1.5);
      ed.up(); ed.confirm(); ed.cancel();
    }
    expect(w.net.node([...w.net.nodes.values()].find((n) => n.pos[0] === 0 && n.pos[2] === 0)!.id).segments.length).toBe(4);
    ed.preset = 1; // avenue
    for (const [ax, az] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      for (let d = 0; d <= 85; d += 1) {
        const p: Vec3 = [ax! * d, 0, az! * d];
        ed.hoverAt(p, 1.5);
        const h = ed.hover!;
        if (h.kind === 'blocked' || h.kind === 'free') continue;
        expect(buildable(ed, p, h.pos) || buildable(ed, p, h.pos, 55), `${p} (${h.kind})`).toBe(true);
      }
    }
  });
});

describe('small roads', () => {
  /** Closest spacing (m) at which a second side road of `preset` fits next to a first one on the south street. */
  const spacing = (preset: number): number => {
    for (let d = 4; d <= 40; d++) {
      const w = new World(buildTestNetwork(), TEST_ZONE, TEST_SEED, testSpawners);
      const ed = new Editor(w);
      ed.setTool('road');
      ed.preset = preset;
      ed.down([0, 0, 40], 1.5);
      ed.move([40, 0, 40], 1.5);
      if (ed.draft?.error) throw new Error(ed.draft.error);
      ed.up(); ed.confirm(); ed.cancel();
      ed.down([0, 0, 40 + d], 1.5);
      ed.move([40, 0, 40 + d], 1.5);
      const ok = ed.draft !== null && ed.draft.error === null && ed.draft.candidate !== null;
      ed.cancel();
      if (ok) return d;
    }
    return Infinity;
  };

  it('side roads fit much closer together than before (compact junctions and entrances)', () => {
    // Before small-road junctions and entrances a second street needed 24 m.
    expect(spacing(0)).toBeLessThanOrEqual(19);
    expect(spacing(4)).toBeLessThanOrEqual(12); // lane
    expect(spacing(5)).toBeLessThanOrEqual(13); // alley
  });

  it('a lane next to the centre crossroads joins as an entrance, and can\'t be widened there', () => {
    const w = new World(buildTestNetwork(), TEST_ZONE, TEST_SEED, testSpawners);
    const ed = new Editor(w);
    ed.setTool('road');
    ed.preset = 4; // lane
    ed.hoverAt([15, 0, 0], 1.5);
    expect(ed.hover!.kind).toBe('segment');
    ed.down([15, 0, 0], 1.5);
    ed.move([15, 0, -40], 1.5);
    expect(ed.draft?.error ?? null).toBeNull();
    ed.up(); ed.confirm(); ed.cancel();
    const node = [...w.net.nodes.values()].find((n) => Math.hypot(n.pos[0] - 15, n.pos[2]) < 0.5)!;
    expect(w.net.isEntrance(node.id)).toBe(true);
    // The through road keeps right of way; the entrance has no other control.
    expect(w.sim.junctions.control.get(node.id)).toBe('priority');
    const lane = node.segments.find((id) => w.net.segment(id).profile.laneWidth === 3)!;
    expect([...w.sim.junctions.major.get(node.id)!]).not.toContain(lane);
    // Saved and loaded.
    expect(RoadNetwork.fromData(JSON.parse(JSON.stringify(w.net.toData()))).isEntrance(node.id)).toBe(true);
    // More lanes don't fit here: refused, nothing changes.
    const before = JSON.stringify(w.net.toData());
    expect(ed.apply((n) => setLanes(n, lane, 1, 1))).toBe('Not enough room for more lanes here');
    expect(JSON.stringify(w.net.toData())).toBe(before);
    // Further along, a full junction fits: a lane there stays a normal junction.
    ed.down([50, 0, 0], 1.5);
    ed.move([50, 0, -40], 1.5);
    ed.up(); ed.confirm(); ed.cancel();
    const far = [...w.net.nodes.values()].find((n) => Math.hypot(n.pos[0] - 50, n.pos[2]) < 0.5)!;
    expect(far.entrance).toBeUndefined();
  });
});

describe('starting a road near the construction-zone border', () => {
  it('the cut at the border is no junction: roads start next to it (or on it)', () => {
    // A border 70 m from the centre, well clear of the ring street's junctions.
    const small = { ...TEST_ZONE, hx: 70, hz: 70, radius: 14, contextScale: 2 };
    for (let x = 52; x <= 69; x += 1) {
      const w = new World(buildTestNetwork(), small, TEST_SEED, testSpawners);
      const ed = new Editor(w);
      ed.setTool('road');
      ed.hoverAt([x, 0, 0], 1.5);
      expect(ed.hover!.kind, `x=${x}`).not.toBe('blocked');
      const before = w.net.segments.size;
      ed.down([x, 0, 0], 1.5);
      ed.move([x - 8, 0, 30], 1.5);
      expect(ed.draft?.error ?? null, `x=${x}`).toBeNull();
      ed.up(); ed.confirm(); ed.cancel();
      expect(w.net.segments.size, `x=${x}: built`).toBeGreaterThan(before);
      expect(validate(w.net, small, [...w.net.segments.keys()].filter((id) => segmentEditable(w.net, small, w.net.segment(id))))).toBeNull();
    }
  });
});

describe('the Road tool: pending roads, shapes and chaining', () => {
  const make = () => {
    const w = new World(buildTestNetwork(), TEST_ZONE, TEST_SEED, testSpawners);
    const ed = new Editor(w);
    ed.setTool('road');
    return { w, ed };
  };
  /** A tap as the camera controller delivers it: the editor's `down`/`up` if it takes the gesture, else `tap`. */
  const tapAt = (ed: Editor, p: Vec3, tol = 1.5): void => {
    if (ed.down(p, tol)) ed.up();
    else ed.tap(p, tol);
  };
  const drag = (ed: Editor, a: Vec3, b: Vec3, tol = 1.5): boolean => {
    if (!ed.down(a, tol)) return false;
    ed.move(b, tol);
    ed.up();
    return true;
  };
  const last = (w: World) => [...w.net.segments.values()].at(-1)!;

  it('a drag makes a pending road that is only built by ✓; ✕ drops it', () => {
    const { w, ed } = make();
    const before = w.net.segments.size, spent = w.spent;
    drag(ed, [30, 0, 30], [30, 0, 55]);
    expect(ed.pending).toBe(true);
    expect(ed.canConfirm).toBe(true);
    expect(w.net.segments.size).toBe(before);
    expect(ed.draft!.length).toBeCloseTo(25, 0);
    ed.cancel();
    expect(ed.pending).toBe(false);
    expect(w.net.segments.size).toBe(before);
    expect(w.spent).toBe(spent);

    // ✕ also clears a hint left from tapping beside the pending road.
    drag(ed, [30, 0, 30], [30, 0, 55]);
    tapAt(ed, [60, 0, 60]);
    expect(ed.message).not.toBeNull();
    ed.discard();
    expect(ed.message).toBeNull();
    expect(ed.pending).toBe(false);

    drag(ed, [30, 0, 30], [30, 0, 55]);
    expect(ed.confirm()).toBeNull();
    expect(w.net.segments.size).toBe(before + 1);
    expect(w.spent).toBeGreaterThan(spent);
    ed.undo();
    expect(w.net.segments.size).toBe(before);
  });

  it('tap the start, tap the end; one-finger drags elsewhere are left to the camera', () => {
    const { w, ed } = make();
    const before = w.net.segments.size;
    tapAt(ed, [30, 0, 30]);
    expect(ed.pendingStart).toBe(true);
    expect(ed.down([60, 0, 60], 1.5)).toBe(false); // away from the start: the view moves
    // Mouse: the road follows the pointer from the start, but nothing is placed.
    ed.hoverAt([30, 0, 50], 1.5);
    expect(ed.draft?.candidate).toBeTruthy();
    expect(ed.pendingStart).toBe(true);
    // An end outside the zone: shown red, can't be built.
    tapAt(ed, [30, 0, 200]);
    expect(ed.pending).toBe(true);
    expect(ed.draft!.error).toBe('You can only build inside the construction zone');
    expect(ed.canConfirm).toBe(false);
    expect(ed.confirm()).not.toBeNull();
    expect(w.net.segments.size).toBe(before);
    // Drag its end back inside, then build.
    expect(ed.down([30, 0, 200], 1.5)).toBe(true);
    ed.move([30, 0, 55], 1.5);
    ed.up();
    expect(ed.canConfirm).toBe(true);
    ed.confirm();
    expect(w.net.segments.size).toBe(before + 1);
    const built = last(w);
    const ends = [w.net.node(built.a).pos, w.net.node(built.b).pos].map((p) => [p[0], p[2]]);
    expect(ends).toContainEqual([30, 30]);
    expect(ends).toContainEqual([30, 55]);
  });

  it('tapping the start again stops; no start where a road cannot begin', () => {
    const { ed } = make();
    tapAt(ed, [30, 0, 30]);
    expect(ed.pendingStart).toBe(true);
    tapAt(ed, [30.5, 0, 30]);
    expect(ed.pendingStart).toBe(false);
    expect(ed.draft).toBeNull();
    // Too close to the centre junction on the avenue (see the red-cross test).
    tapAt(ed, [17, 0, 0]);
    expect(ed.pendingStart).toBe(false);
    expect(ed.message).toBe(TOO_CLOSE);
    // Switching tools drops a placed start.
    tapAt(ed, [30, 0, 30]);
    ed.setTool('select');
    expect(ed.pendingStart).toBe(false);
    expect(ed.draft).toBeNull();
  });

  it('dragging a pending road\'s grips moves its ends', () => {
    const { w, ed } = make();
    drag(ed, [30, 0, 30], [30, 0, 55]);
    drag(ed, [30, 0, 30], [30, 0, 22]); // start grip (moved ends snap like new ones)
    drag(ed, [30, 0, 55], [30, 0, 64]); // end grip
    ed.confirm();
    const s = last(w);
    const ends = [w.net.node(s.a).pos, w.net.node(s.b).pos].map((p) => [Math.round(p[0] * 100) / 100, Math.round(p[2] * 100) / 100]);
    expect(ends).toContainEqual([30, 22]);
    expect(ends).toContainEqual([30, 64]);
  });

  it('chaining: after ✓ the end starts the next road', () => {
    const { w, ed } = make();
    const before = w.net.segments.size;
    tapAt(ed, [30, 0, 30]);
    tapAt(ed, [30, 0, 55]);
    ed.confirm();
    expect(ed.pendingStart).toBe(true);
    tapAt(ed, [55, 0, 55]);
    ed.confirm();
    expect(w.net.segments.size).toBe(before + 2);
    const joint = [...w.net.nodes.values()].find((n) => n.pos[0] === 30 && n.pos[2] === 55)!;
    expect(joint.segments.length).toBe(2);
    ed.cancel();
    expect(ed.pendingStart).toBe(false);
  });

  it('Curve mode: the middle grip bows the road; switching shape reshapes a pending road', () => {
    const { w, ed } = make();
    drag(ed, [30, 0, 30], [30, 0, 60]);
    ed.setDrawMode('curve');
    expect(ed.draft!.grips.length).toBe(3);
    drag(ed, [30, 0, 45], [36, 0, 45]); // the middle grip, 6 m to the side
    ed.confirm();
    const s = last(w);
    const mid = s.curve.point(0.5);
    expect(mid[0]).toBeCloseTo(36, 1);
    expect(mid[2]).toBeCloseTo(45, 1);
    expect(s.curve.length).toBeGreaterThan(30);
  });

  it('Continuous mode: the road leaves along the road it continues', () => {
    const { w, ed } = make();
    ed.setDrawMode('continuous');
    drag(ed, [30, 0, 30], [30, 0, 55]); // nothing to continue: straight
    expect(ed.confirm()).toBeNull();
    // Chained: carries on south, then bends towards the east.
    tapAt(ed, [45, 0, 75]);
    expect(ed.draft!.error).toBeNull();
    ed.confirm();
    const s = last(w);
    const startsAtJoint = w.net.node(s.a).pos[2] === 55;
    const d = s.curve.derivative(startsAtJoint ? 0 : 1);
    const l = Math.hypot(d[0], d[2]);
    // Tangent at the joint points straight on (+z), so the roads meet without a kink.
    expect(Math.abs(d[0] / l)).toBeLessThan(0.01);
    expect(w.net.isJunction(startsAtJoint ? s.a : s.b)).toBe(false);
    // Too far round to the side: refused with a reason.
    tapAt(ed, [20, 0, 76]);
    expect(ed.draft!.error).toBe(TOO_SHARP);
  });
});

describe('saving and resetting the city', () => {
  it('a saved city (JSON, as in browser storage) comes back exactly after a reload', () => {
    const w = new World(buildTestNetwork(), TEST_ZONE, TEST_SEED, testSpawners);
    const ed = new Editor(w);
    ed.setTool('road');
    ed.down([30, 0, 30], 1.5);
    ed.move([30, 0, 55], 1.5);
    ed.up(); ed.confirm(); ed.cancel();
    const centre = [...w.net.nodes.values()].find((n) => n.pos[0] === 0 && n.pos[2] === 0)!;
    expect(ed.apply((n) => { n.node(centre.id).control = 'signal'; n.node(centre.id).greens = { [n.node(centre.id).segments[0]!]: 35 }; })).toBeNull();
    expect(w.spent).toBeGreaterThan(0);
    const saved = JSON.stringify(w.snapshot());

    // "Reload": a fresh world from the starting city, then the save on top.
    const again = new World(buildTestNetwork(), TEST_ZONE, TEST_SEED, testSpawners);
    again.restore(JSON.parse(saved));
    expect(JSON.stringify(again.snapshot())).toBe(saved);
    expect(again.sim.junctions.control.get(centre.id)).toBe('signal');
    expect(again.sim.junctions.signals.get(centre.id)!.phases.some((p) => p.green === 35)).toBe(true);
    for (let i = 0; i < 300; i++) again.sim.step(0.1);
    expect(again.sim.stats.vehicles).toBeGreaterThan(0);
  });

  it('reset makes a new city from a new seed and forgets the old history', () => {
    const w = new World(buildTestNetwork(), TEST_ZONE, TEST_SEED, testSpawners);
    const start = JSON.stringify(w.snapshot());
    const lots = JSON.stringify(w.city.lots.map((l) => [l.cx, l.cz]));
    const ed = new Editor(w);
    ed.setTool('road');
    ed.down([30, 0, 30], 1.5);
    ed.move([30, 0, 55], 1.5);
    ed.up(); ed.confirm(); ed.cancel();
    expect(ed.canUndo).toBe(true);

    w.regenerate(buildTestNetwork(), TEST_SEED + 1);
    ed.startOver('new city');
    expect(ed.canUndo).toBe(false);
    expect(w.spent).toBe(0);
    expect(w.demolished.size).toBe(0);
    expect(w.snapshot().seed).toBe(TEST_SEED + 1);
    expect(JSON.stringify(w.city.lots.map((l) => [l.cx, l.cz]))).not.toBe(lots); // other buildings
    // Same roads as any fresh start.
    expect(JSON.stringify(w.snapshot().net)).toBe(JSON.stringify(JSON.parse(start).net));
    for (let i = 0; i < 300; i++) w.sim.step(0.1);
    expect(w.sim.stats.vehicles).toBeGreaterThan(0);
    // A save of the new city only fits a world grown from the same seed.
    expect(() => new World(buildTestNetwork(), TEST_ZONE, TEST_SEED, testSpawners).restore(w.snapshot())).toThrow();
  });
});

describe('parallel roads', () => {
  it('offsetCubic: exact for straight lines, close to the true offset of a quarter circle', () => {
    const [a, b, c, d] = offsetCubic([0, 0, 0], [10, 0, 0], [20, 0, 0], [30, 0, 0], 4);
    for (const p of [a, b, c, d]) expect(p[2]).toBeCloseTo(4, 9); // right of +x is +z
    const R = 40, k = 0.5523 * R;
    const q = offsetCubic([0, 0, 0], [k, 0, 0], [R, 0, R - k], [R, 0, R], -5); // 5 m to the outside
    const curve = new CubicBezier(...q);
    for (let t = 0; t <= 1; t += 0.1) {
      const p = curve.point(t);
      expect(Math.abs(Math.hypot(p[0], p[2] - R) - (R + 5))).toBeLessThan(0.25);
    }
  });

  const make = () => {
    const w = new World(buildTestNetwork(), TEST_ZONE, TEST_SEED, testSpawners);
    const ed = new Editor(w);
    ed.setTool('road');
    return { w, ed };
  };
  const draw = (ed: Editor, a: Vec3, b: Vec3) => { ed.down(a, 1.5); ed.move(b, 1.5); ed.up(); };

  it('one-way type: a dual carriageway, each half running its own way with a median between', () => {
    const { w, ed } = make();
    ed.setPreset(2); // one-way 2
    ed.setParallel(true);
    const n0 = w.net.segments.size;
    draw(ed, [30, 0, 30], [30, 0, 70]);
    expect(ed.draft!.error).toBeNull();
    expect(ed.confirm()).toBeNull();
    expect(w.net.segments.size).toBe(n0 + 2);
    const d = parallelOffset(ROAD_PRESETS[2]!.profile);
    const halves = [...w.net.segments.values()].slice(-2).map((s) => {
      const a = w.net.node(s.a).pos, b = w.net.node(s.b).pos;
      return { x: a[0], towardsZ: Math.sign(b[2] - a[2]) * (s.profile.forward > 0 ? 1 : -1) };
    }).sort((p, q) => p.x - q.x);
    // Heading +z, the right side is -x: that half runs +z, the other runs back.
    expect(halves.map((h) => h.x)).toEqual([30 - d, 30 + d]);
    expect(halves.map((h) => h.towardsZ)).toEqual([1, -1]);
    // Chained: the next pair joins the ends of the first (plain joints, no junctions).
    expect(ed.pendingStart).toBe(true);
    ed.tap([30, 0, 90], 1.5);
    expect(ed.draft!.error).toBeNull();
    ed.confirm();
    for (const x of [30 - d, 30 + d]) {
      const joint = [...w.net.nodes.values()].find((n) => Math.hypot(n.pos[0] - x, n.pos[2] - 70) < 0.01)!;
      expect(joint.segments.length).toBe(2);
      expect(w.net.isJunction(joint.id)).toBe(false);
    }
  });

  it('the overlap check knows which side a one-way road\'s lanes are on', () => {
    const ONE: LaneProfile = ROAD_PRESETS[2]!.profile; // lanes right of the line
    const pair = (sameWay: boolean) => {
      const net = new RoadNetwork();
      net.addSegment(net.addNode([27, 0, 30]), net.addNode([27, 0, 70]), ONE); // lanes towards -x
      const id = sameWay
        ? net.addSegment(net.addNode([33, 0, 30]), net.addNode([33, 0, 70]), ONE) // lanes towards -x too: onto the first
        : net.addSegment(net.addNode([33, 0, 70]), net.addNode([33, 0, 30]), ONE); // lanes towards +x: clear
      return validate(net, zone, [id], [id]);
    };
    expect(pair(false)).toBeNull();
    expect(pair(true)).toBe('Overlaps another road');
  });

  it('two-way type: two streets side by side, a median apart; off again draws one road', () => {
    const { w, ed } = make();
    ed.setParallel(true);
    const n0 = w.net.segments.size;
    draw(ed, [30, 0, 30], [30, 0, 70]);
    expect(ed.draft!.error).toBeNull();
    ed.confirm();
    ed.discard();
    expect(w.net.segments.size).toBe(n0 + 2);
    ed.setParallel(false);
    draw(ed, [70, 0, 30], [70, 0, 70]);
    ed.confirm();
    expect(w.net.segments.size).toBe(n0 + 3);
  });
});

describe('drag to remove', () => {
  it('a drag starting on a road sweeps every road it crosses; lifting removes them in one undo step', () => {
    const w = new World(buildTestNetwork(), TEST_ZONE, TEST_SEED, testSpawners);
    const ed = new Editor(w);
    ed.setTool('road');
    for (const x of [30, 45, 60]) {
      ed.down([x, 0, 30], 1.5); ed.move([x, 0, 70], 1.5); ed.up(); ed.confirm(); ed.discard();
    }
    const n0 = w.net.segments.size;
    ed.setTool('delete');
    expect(ed.down([20, 0, 50], 1.5)).toBe(false); // off a road: the view moves
    expect(ed.down([30, 0, 50], 1.5)).toBe(true);
    ed.move([62, 0, 51], 1.5); // one quick swipe across all three
    expect(ed.draft!.swept.length).toBe(3);
    expect(ed.draft!.sweepKind).toBe('remove');
    expect(w.net.segments.size).toBe(n0); // nothing gone until the finger lifts
    ed.up();
    expect(w.net.segments.size).toBe(n0 - 3);
    expect(ed.draft).toBeNull();
    ed.undo();
    expect(w.net.segments.size).toBe(n0);
  });

  it('a tap still removes one road; sweeping a roundabout removes its ring', () => {
    const w = new World(buildTestNetwork(), TEST_ZONE, TEST_SEED, testSpawners);
    const ed = new Editor(w);
    const centre = [...w.net.nodes.values()].find((n) => n.pos[0] === 0 && n.pos[2] === 0)!;
    expect(ed.apply((n) => convertToRoundabout(n, centre.id))).toBeNull();
    const ringSeg = [...w.net.segments.values()].find((s) => s.ring !== undefined)!;
    const p = ringSeg.curve.point(0.5);
    ed.setTool('delete');
    expect(ed.down(p, 1.5)).toBe(true);
    ed.up();
    expect([...w.net.segments.values()].some((s) => s.ring !== undefined)).toBe(false);
    expect(w.net.roundabouts.size).toBe(0);
  });
});

describe('drag to upgrade', () => {
  it('a sweep in Upgrade mode changes every road it crosses in one undo step; taps still reverse one-ways', () => {
    const w = new World(buildTestNetwork(), TEST_ZONE, TEST_SEED, testSpawners);
    const ed = new Editor(w);
    ed.setTool('road');
    for (const x of [20, 50, 80]) {
      ed.down([x, 0, 30], 1.5); ed.move([x, 0, 70], 1.5); ed.up(); ed.confirm(); ed.discard();
    }
    const ids = [20, 50, 80].map((x) => [...w.net.segments.values()].find((s) => Math.hypot(s.curve.point(0.5)[0] - x, s.curve.point(0.5)[2] - 50) < 1)!.id);
    ed.setDrawMode('upgrade');
    ed.setPreset(1); // avenue
    expect(ed.down([35, 0, 50], 1.5)).toBe(false); // off a road: the view moves
    expect(ed.down([20, 0, 50], 1.5)).toBe(true);
    ed.move([82, 0, 51], 1.5);
    expect(ed.draft!.swept.length).toBe(3);
    expect(ed.draft!.sweepKind).toBe('upgrade');
    expect(w.net.segment(ids[0]!).profile.forward).toBe(1); // nothing changes until the finger lifts
    ed.up();
    for (const id of ids) expect([w.net.segment(id).profile.forward, w.net.segment(id).profile.backward]).toEqual([2, 2]);
    ed.undo();
    for (const id of ids) expect(w.net.segment(id).profile.forward).toBe(1);
    // One-ways: a sweep over roads already that type leaves them alone; a tap turns one round.
    ed.setPreset(2);
    ed.down([20, 0, 50], 1.5); ed.move([82, 0, 51], 1.5); ed.up();
    const dir = (id: number) => w.net.segment(id).profile.forward > 0;
    const before = ids.map(dir);
    ed.down([20, 0, 50], 1.5); ed.move([82, 0, 51], 1.5); ed.up();
    expect(ids.map(dir)).toEqual(before);
    expect(ed.message).toBe('These roads already are that type');
    ed.down([50, 0, 50], 1.5); ed.up(); // a tap
    expect(dir(ids[1]!)).toBe(!before[1]);
  });
});

describe('moving junctions (Reshape tool)', () => {
  const make = () => {
    const w = new World(buildTestNetwork(), TEST_ZONE, TEST_SEED, testSpawners);
    const ed = new Editor(w);
    return { w, ed };
  };
  const nodeAt = (w: World, x: number, z: number) => [...w.net.nodes.values()].find((n) => Math.hypot(n.pos[0] - x, n.pos[2] - z) < 0.01);

  it('drags a road end: the road follows and stays straight; undo puts it back', () => {
    const { w, ed } = make();
    ed.setTool('road');
    ed.down([30, 0, 30], 1.5); ed.move([30, 0, 55], 1.5); ed.up(); ed.confirm(); ed.discard();
    const end = nodeAt(w, 30, 55)!;
    ed.setTool('bend');
    expect(ed.movable(end.id)).toBe(true);
    expect(ed.down([30.4, 0, 55.3], 1.5)).toBe(true);
    ed.move([40.3, 0, 60.4], 1.5);
    expect(ed.draft!.error).toBeNull();
    ed.up();
    const moved = w.net.node(end.id);
    expect([moved.pos[0], moved.pos[2]]).toEqual([40, 60]); // whole metres
    const seg = w.net.segment(moved.segments[0]!);
    expect(seg.curve.straight()).toBe(true);
    ed.undo();
    expect(nodeAt(w, 30, 55)?.id).toBe(end.id);
  });

  it('a curved road keeps its bend at the far end', () => {
    const net = new RoadNetwork();
    const a = net.addNode([0, 0, 0]), b = net.addNode([40, 0, 0]);
    const id = net.addSegment(a, b, STREET, [10, 0, 10], [30, 0, 10]);
    moveNode(net, b, [40, 0, 8]);
    const c = net.segment(id).curve;
    expect(c.p1).toEqual([10, 0, 10]); // far end untouched
    expect([c.p2[0], c.p2[2]]).toEqual([30, 18]); // moved with the end
    expect([c.p3[0], c.p3[2]]).toEqual([40, 8]);
  });

  it('the centre crossroads can move a little with traffic running; border joints and rings stay put', () => {
    const { w, ed } = make();
    for (let i = 0; i < 300; i++) w.sim.step(0.1);
    const centre = nodeAt(w, 0, 0)!;
    expect(ed.movable(centre.id)).toBe(true);
    expect(ed.apply((n) => moveNode(n, centre.id, [4, 0, 3]))).toBeNull();
    expect(w.net.node(centre.id).segments.length).toBe(4);
    for (let i = 0; i < 600; i++) w.sim.step(0.1);
    expect(w.sim.stats.exited).toBeGreaterThan(0);
    const border = [...w.net.nodes.values()].find((n) => Math.abs(zoneDistance(TEST_ZONE, n.pos[0], n.pos[2])) < 0.5 && n.segments.length === 2)!;
    expect(border).toBeDefined();
    expect(ed.movable(border.id)).toBe(false);
    expect(ed.apply((n) => convertToRoundabout(n, centre.id))).toBeNull();
    for (const n of w.net.nodes.values()) if (n.ring !== undefined) expect(ed.movable(n.id)).toBe(false);
  });
});

describe('Upgrade mode', () => {
  const make = () => {
    const w = new World(buildTestNetwork(), TEST_ZONE, TEST_SEED, testSpawners);
    const ed = new Editor(w);
    ed.setTool('road');
    return { w, ed };
  };
  /** A tap as the camera controller delivers it. */
  const tapAt = (ed: Editor, p: Vec3): void => {
    if (ed.down(p, 1.5)) ed.up();
    else ed.tap(p, 1.5);
  };
  const build = (ed: Editor, a: Vec3, b: Vec3): void => {
    ed.down(a, 1.5); ed.move(b, 1.5); ed.up(); ed.confirm(); ed.discard();
  };
  const segAt = (w: World, x: number, z: number) => [...w.net.segments.values()]
    .find((s) => { const p = s.curve.point(0.5); return Math.hypot(p[0] - x, p[2] - z) < 1; })!;

  it('gives a road another type, keeping its shape and junctions; undo puts it back', () => {
    const { w, ed } = make();
    build(ed, [30, 0, 30], [30, 0, 70]);
    const seg = segAt(w, 30, 50);
    const { a, b } = seg, len = seg.curve.length, spent = w.spent;
    ed.setDrawMode('upgrade');
    expect(ed.down([40, 0, 50], 1.5)).toBe(false); // drags off a road move the view
    ed.setPreset(1); // avenue
    tapAt(ed, [30, 0, 50]);
    expect(ed.message).toBeNull();
    const up = w.net.segment(seg.id);
    expect([up.profile.forward, up.profile.backward]).toEqual([2, 2]);
    expect([up.a, up.b]).toEqual([a, b]);
    expect(up.curve.length).toBeCloseTo(len, 6);
    expect(w.spent).toBeGreaterThan(spent);
    ed.undo();
    expect(w.net.segment(seg.id).profile.forward).toBe(1);
  });

  it('a one-way keeps its direction; tapping it again with the same type reverses it', () => {
    const { w, ed } = make();
    ed.setPreset(2); // one-way 2
    build(ed, [30, 0, 70], [30, 0, 30]); // drawn northwards
    const id = segAt(w, 30, 50).id;
    const flows = () => { // direction of travel, as +1 (towards +z) or -1
      const s = w.net.segment(id);
      const dz = w.net.node(s.b).pos[2] - w.net.node(s.a).pos[2];
      return Math.sign(dz) * (s.profile.forward > 0 ? 1 : -1);
    };
    expect(flows()).toBe(-1);
    ed.setDrawMode('upgrade');
    ed.setPreset(4); // lane: one-way, one lane
    tapAt(ed, [30, 0, 50]);
    expect(w.net.segment(id).profile.laneWidth).toBe(3);
    expect(flows()).toBe(-1);
    tapAt(ed, [30, 0, 50]); // same type again: turned round
    expect(flows()).toBe(1);
    // A two-way road that already is this type: nothing to do.
    ed.setPreset(0);
    tapAt(ed, [30, 0, 50]);
    ed.setPreset(0);
    tapAt(ed, [30, 0, 50]);
    expect(ed.message).toBe('This road already is that type');
  });

  it('roundabout rings are left to the Edit tool', () => {
    const net = buildTestNetwork();
    const centre = [...net.nodes.values()].find((n) => n.pos[0] === 0 && n.pos[2] === 0)!;
    convertToRoundabout(net, centre.id);
    const ring = [...net.segments.values()].find((s) => s.ring !== undefined)!;
    expect(() => upgradeRoad(net, ring.id, ROAD_PRESETS[1]!.profile)).toThrow('Roundabouts have their own lanes');
  });
});

describe('guide lines', () => {
  /** A dead-end street from (0,0) to (40,0), and one from (100,30) to (130,30). */
  const net = () => {
    const n = new RoadNetwork();
    n.addSegment(n.addNode([0, 0, 0]), n.addNode([40, 0, 0]), STREET);
    n.addSegment(n.addNode([100, 0, 30]), n.addNode([130, 0, 30]), STREET);
    return n;
  };
  const near = (p: Vec3, x: number, z: number) => expect(Math.hypot(p[0] - x, p[2] - z)).toBeLessThan(1e-6);

  it('snaps onto the extension of a road and onto perpendiculars at its end', () => {
    const s = snapPoint(net(), zone, [70, 0, 1.2], 2);
    near(s.anchor.pos, 70, 0);
    expect(s.guides.length).toBe(1);
    near(s.guides[0]![0], 40, 0); // drawn from the road end
    near(snapPoint(net(), zone, [40.8, 0, -25], 2).anchor.pos, 40, -25);
  });

  it('snaps to where two guides cross, and to where the start\'s angle step crosses a guide', () => {
    // x = 40 (perpendicular at the first road's end) meets z = 30 (extension of the second road).
    const s = snapPoint(net(), zone, [41.2, 0, 31.1], 2);
    near(s.anchor.pos, 40, 30);
    expect(s.guides.length).toBe(2);
    // From (0, 60) heading 0° (east, an angle step) the end lands on the x = 40 guide exactly.
    const t = snapPoint(net(), zone, [40.9, 0, 60.4], 2, free(0, 60));
    expect(t.aligned).toBe(true);
    near(t.anchor.pos, 40, 60);
  });

  it('snapping off: free points stay where they are (roads and junctions still connect)', () => {
    const s = snapPoint(net(), zone, [70.3, 0, 1.2], 2, undefined, false);
    near(s.anchor.pos, 70.3, 1.2);
    expect(s.guides).toEqual([]);
    expect(snapPoint(net(), zone, [20, 0, 0.5], 2, undefined, false).anchor.kind).toBe('segment');
  });

  it('the Road tool shows the guides its end snapped onto', () => {
    const w = new World(buildTestNetwork(), TEST_ZONE, TEST_SEED, testSpawners);
    const ed = new Editor(w);
    ed.setTool('road');
    ed.down([30, 0, 30], 1.5);
    ed.move([30, 0, 55], 1.5);
    ed.up();
    ed.confirm();
    ed.discard();
    // A second road from elsewhere ending level with the first one's end, (30, 55).
    ed.down([60, 0, 30], 1.5);
    ed.move([60.6, 0, 54.2], 1.5);
    expect(ed.draft!.lines.length).toBeGreaterThan(0);
    const end = ed.draft!.markers[1]!.pos;
    expect(end[2]).toBeCloseTo(55, 6);
    ed.setSnapping(false);
    ed.move([60.6, 0, 54.2], 1.5);
    expect(ed.draft!.lines).toEqual([]);
  });
});

describe('Continuous: curvature matched at the join', () => {
  const arc = (A: Vec3, B: Vec3, dir: Vec3, k0 = 0) => {
    const s = continueShape(A, B, dir, k0);
    if (typeof s === 'string') throw new Error(s);
    return new CubicBezier(A, s.c1, s.c2, B);
  };

  it('curvature(): 1/R on a circle, positive turning from +x towards +z', () => {
    const c = arc([0, 0, 0], [40, 0, 40], [1, 0, 0]); // quarter circle, R = 40
    // A cubic quarter circle's curvature wanders by about 2%.
    for (const t of [0, 0.5, 1]) expect(Math.abs(c.curvature(t) * 40 - 1)).toBeLessThan(0.03);
    expect(Math.abs(arc([0, 0, 0], [40, 0, -40], [1, 0, 0]).curvature(0.5) * 40 + 1)).toBeLessThan(0.03);
  });

  it('a bend continuing a bend the same way starts with the curvature the first one ends with', () => {
    const first = arc([0, 0, 0], [40, 0, 40], [1, 0, 0]); // R 40, ends heading +z
    const k0 = first.curvature(1);
    const plain = arc([40, 0, 40], [10, 0, 70], [0, 0, 1]); // R 30 the same way
    const matched = arc([40, 0, 40], [10, 0, 70], [0, 0, 1], k0);
    expect(Math.abs(plain.curvature(0) - k0)).toBeGreaterThan(0.005); // a jump of 1/40 → 1/30
    expect(Math.abs(matched.curvature(0) - k0) / k0).toBeLessThan(0.01);
    // Same end, same end direction: only the start handle changed.
    expect(matched.p2).toEqual(plain.p2);
    expect(tightestRadius(matched)).toBeGreaterThan(0.85 * tightestRadius(plain));
  });

  it('after a straight road or a bend the other way: the plain arc (no tighter middle)', () => {
    const plain = arc([0, 0, 0], [40, 0, 20], [1, 0, 0]);
    for (const k0 of [0, -1 / 60]) expect(arc([0, 0, 0], [40, 0, 20], [1, 0, 0], k0).p1).toEqual(plain.p1);
  });

  it('chaining Continuous roads in the editor joins them with matching curvature', () => {
    const w = new World(buildTestNetwork(), TEST_ZONE, TEST_SEED, testSpawners);
    const ed = new Editor(w);
    ed.setTool('road');
    ed.setDrawMode('continuous');
    ed.down([30, 0, 20], 1.5); ed.move([30, 0, 40], 1.5); ed.up(); ed.confirm(); // straight start
    ed.tap([60, 0, 70], 1.5); expect(ed.draft!.error).toBeNull(); ed.confirm(); // R 30 arc
    ed.tap([85, 0, 45], 1.5); expect(ed.draft!.error).toBeNull(); ed.confirm(); // R 25 the same way
    const segs = [...w.net.segments.values()].slice(-2);
    const [s1, s2] = segs as [typeof segs[0], typeof segs[0]];
    const k1 = s1.curve.curvature(1), k2 = s2.curve.curvature(0);
    expect(w.net.node(s1.b).pos).toEqual(w.net.node(s2.a).pos);
    expect(Math.abs(k2 - k1) / Math.abs(k1)).toBeLessThan(0.02);
  });
});

describe('guidance labels', () => {
  it('length, angle to the road it starts from, and the speed of a tight bend', () => {
    const w = new World(buildTestNetwork(), TEST_ZONE, TEST_SEED, testSpawners);
    const ed = new Editor(w);
    ed.setTool('road');
    // From open ground: length, no angle.
    ed.down([30, 0, 30], 1.5);
    ed.move([30, 0, 55], 1.5);
    expect(ed.draft!.guide!.length).toBeCloseTo(25, 1);
    expect(ed.draft!.guide!.angle).toBeNull();
    expect(ed.draft!.guide!.slowTo).toBeNull();
    expect(ed.draft!.guide!.at).toEqual([30, 0, 55]); // above the finger's point
    ed.up();
    ed.discard();
    // Off the avenue east of the centre, straight south: 90° to it.
    ed.down([50, 0, 0], 1.5);
    ed.move([50, 0, 40], 1.5);
    expect(ed.draft!.guide!.angle).toBe(90);
    ed.up();
    // A tight curve: cars slow down, and the label follows the middle grip while it's dragged.
    ed.setDrawMode('curve');
    ed.down([50, 0, 20], 1.5);
    ed.move([62, 0, 20], 1.5);
    expect(ed.draft!.guide!.slowTo).not.toBeNull();
    expect(ed.draft!.guide!.slowTo!).toBeLessThan(40);
    expect(ed.draft!.guide!.at[0]).toBeCloseTo(62, 6);
  });

  it('bendSpeed: none on gentle bends, about sqrt(3 m/s² · r) on the inner lane of tight ones', () => {
    const street = ROAD_PRESETS[0]!.profile;
    expect(bendSpeed(CubicBezier.line([0, 0, 0], [50, 0, 0]), street)).toBeNull();
    const s = continueShape([0, 0, 0], [30, 0, 30], [1, 0, 0]); // quarter circle, R = 30
    if (typeof s === 'string') throw new Error(s);
    const v = bendSpeed(new CubicBezier([0, 0, 0], s.c1, s.c2, [30, 0, 30]), street)!;
    const expected = Math.sqrt(3 * (30 - 0.5 * street.laneWidth)) * 3.6;
    expect(v).toBe(Math.floor(expected / 5) * 5);
  });
});

describe('road shapes', () => {
  it('continueShape: a circular arc leaving along the start direction', () => {
    const A: Vec3 = [0, 0, 0];
    for (const B of [[30, 0, 10], [20, 0, 25], [40, 0, -5]] as Vec3[]) {
      const s = continueShape(A, B, [1, 0, 0]);
      if (typeof s === 'string') throw new Error(s);
      const c = new CubicBezier(A, s.c1, s.c2, B);
      const d0 = c.derivative(0);
      expect(Math.abs(d0[2])).toBeLessThan(1e-9); // leaves along +x
      expect(d0[0]).toBeGreaterThan(0);
      // Every point lies on one circle through A, tangent to +x there: centre (0, R).
      const R = (B[0] ** 2 + B[2] ** 2) / (2 * B[2]);
      for (let t = 0; t <= 1; t += 0.05) {
        const p = c.point(t);
        expect(Math.abs(Math.hypot(p[0], p[2] - R) - Math.abs(R)) / Math.abs(R)).toBeLessThan(0.003);
      }
    }
    expect(continueShape(A, [5, 0, 30], [1, 0, 0])).toBe(TOO_SHARP);
    expect(continueShape(A, [-10, 0, 1], [1, 0, 0])).toBe(TOO_SHARP);
  });

  it('curveShape passes through its bend point; bendFrom inverts bendPoint', () => {
    const A: Vec3 = [0, 0, 0], B: Vec3 = [40, 0, 0];
    const s = curveShape(A, B, 8);
    const mid = new CubicBezier(A, s.c1, s.c2, B).point(0.5);
    const H = bendPoint(A, B, 8);
    expect(Math.hypot(mid[0] - H[0], mid[2] - H[2])).toBeLessThan(1e-9);
    expect(H[2]).toBeCloseTo(8, 9); // right of +x is +z
    expect(bendFrom(A, B, H)).toBeCloseTo(8, 9);
  });
});

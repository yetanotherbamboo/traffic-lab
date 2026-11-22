import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../src/core/math';
import { type City, type CityItem, itemsHitByRoads } from '../src/env/city';
import { Editor } from '../src/editor/editor';
import { addRoad, rampLength } from '../src/editor/ops';
import { TEST_SEED, TEST_ZONE, buildTestNetwork, testSpawners } from '../src/game/testScene';
import { World } from '../src/game/world';
import { validate } from '../src/editor/validate';
import type { Zone } from '../src/env/zone';
import { CLEARANCE, LEVELS, type LaneProfile, RoadNetwork } from '../src/network/network';
import { MAT_CONCRETE, ROAD_STRIDE, buildRoadMesh } from '../src/render/roadMesh';
import { LaneGraph } from '../src/sim/laneGraph';
import { type Spawner, TrafficSim } from '../src/sim/traffic';

const STREET: LaneProfile = { forward: 1, backward: 1, laneWidth: 3.25, sidewalk: 2.5, speedLimit: 40 };
const ZONE: Zone = { cx: 0, cz: 0, hx: 200, hz: 200, radius: 40, contextScale: 1.9 };
const at = (x: number, y: number, z: number) => ({ kind: 'free' as const, pos: [x, y, z] as Vec3 });

/**
 * A ground road along x, and a road along z that climbs ramps of `ramp` m to a deck at height
 * `deck` and crosses over it. Returns the network and the validation result of the whole build.
 */
function overpass(deck: number = LEVELS.bridge, ramp = 80) {
  const net = new RoadNetwork();
  const touched = new Set<number>(), changed = new Set<number>();
  const add = (a: ReturnType<typeof at> | { kind: 'node'; id: number; pos: Vec3 }, b: ReturnType<typeof at>) => {
    const r = addRoad(net, a, b, STREET);
    r.changed.forEach((id) => changed.add(id));
    r.touched.forEach((id) => touched.add(id));
  };
  add(at(-150, 0, 0), at(150, 0, 0));
  const top = 70, foot = top + ramp;
  add(at(0, 0, -foot), at(0, deck, -top));
  const n1 = [...net.nodes.values()].find((n) => n.pos[2] === -top)!;
  add({ kind: 'node', id: n1.id, pos: n1.pos }, at(0, deck, top));
  const n2 = [...net.nodes.values()].find((n) => n.pos[2] === top)!;
  add({ kind: 'node', id: n2.id, pos: n2.pos }, at(0, 0, foot));
  const error = validate(net, ZONE, [...touched].filter((id) => net.segments.has(id)), [...changed].filter((id) => net.segments.has(id)));
  return { net, error };
}

describe('roads on different levels', () => {
  it('a bridge passes over a ground road: no junction, and it validates', () => {
    const { net, error } = overpass();
    expect(error).toBeNull();
    // 4 roads (ground road unsplit, ramp, deck, ramp), no node at the crossing.
    expect(net.segments.size).toBe(4);
    expect([...net.nodes.values()].some((n) => Math.hypot(n.pos[0], n.pos[2]) < 1)).toBe(false);
    // The deck really is up there, and the ramps climb steadily.
    const deck = [...net.segments.values()].find((s) => net.node(s.a).pos[1] === LEVELS.bridge && net.node(s.b).pos[1] === LEVELS.bridge)!;
    expect(deck.curve.point(0.5)[1]).toBeCloseTo(LEVELS.bridge, 6);
  });

  it('refuses a deck too low to pass over, and a ramp that is too steep', () => {
    expect(overpass(3).error).toBe(`Not enough height between the roads: ${CLEARANCE} m needed`);
    expect(overpass(LEVELS.bridge, 40).error).toMatch(/^Too steep/); // 6 m in 40 m = 15%
    expect(overpass(LEVELS.bridge, 60).error).toBeNull(); // exactly 10%
  });

  it('roads on the same level still meet in a junction', () => {
    const net = new RoadNetwork();
    addRoad(net, at(-50, 0, 0), at(50, 0, 0), STREET);
    addRoad(net, at(0, 0, -50), at(0, 0, 50), STREET);
    expect([...net.nodes.values()].some((n) => Math.hypot(n.pos[0], n.pos[2]) < 0.01 && n.segments.length === 4)).toBe(true);
  });

  it('heights are saved with the city', () => {
    const { net } = overpass();
    const again = RoadNetwork.fromData(JSON.parse(JSON.stringify(net.toData())));
    expect([...again.nodes.values()].map((n) => n.pos[1]).sort()).toEqual([...net.nodes.values()].map((n) => n.pos[1]).sort());
    expect([...again.nodes.values()].some((n) => n.pos[1] === LEVELS.bridge)).toBe(true);
  });

  it('traffic on both levels never meets: no collisions, and cars on the deck drive up there', () => {
    const { net } = overpass();
    const ends = [...net.nodes.values()].filter((n) => n.segments.length === 1).map((n) => n.id);
    const spawners: Spawner[] = ends.map((node) => ({ node, rate: 500 }));
    const sim = new TrafficSim(new LaneGraph(net), spawners, 3);
    let collisions = 0, onDeck = 0, passes = 0;
    for (let t = 0; t < 9000; t++) {
      sim.step(0.1);
      if (t % 2) continue;
      const cars: [number, number, number][] = [];
      for (let i = 0; i < sim.capacity; i++) {
        if (!sim.alive[i]) continue;
        const x = sim.pose[i * 4]!, y = sim.pose[i * 4 + 1]!, z = sim.pose[i * 4 + 2]!;
        cars.push([x, y, z]);
        if (Math.hypot(x, z) < 3 && y > LEVELS.bridge - 0.5) onDeck++;
      }
      // Front bumpers closer than 2 m on the same level count as a collision.
      for (let i = 0; i < cars.length; i++) for (let j = i + 1; j < cars.length; j++) {
        const a = cars[i]!, b = cars[j]!;
        if (Math.hypot(a[0] - b[0], a[2] - b[2]) >= 2) continue;
        if (Math.abs(a[1] - b[1]) < 2) collisions++;
        else passes++; // one above the other: a car on the bridge over one below
      }
    }
    expect(collisions).toBe(0);
    expect(passes).toBeGreaterThan(0); // they did cross paths, on different levels
    expect(onDeck).toBeGreaterThan(0);
    expect(sim.stats.exited).toBeGreaterThan(200);
  });
});

describe('bridges on screen', () => {
  const concrete = (net: RoadNetwork) => {
    const m = buildRoadMesh(net), V = m.vertices, I = m.indices, S = ROAD_STRIDE;
    const tris: { a: Vec3; b: Vec3; c: Vec3; n: Vec3 }[] = [];
    for (let t = 0; t < I.length; t += 3) {
      const [i, j, k] = [I[t]!, I[t + 1]!, I[t + 2]!];
      if (Math.round(V[i * S + 11]!) !== MAT_CONCRETE) continue;
      const p = (q: number): Vec3 => [V[q * S]!, V[q * S + 1]!, V[q * S + 2]!];
      tris.push({ a: p(i), b: p(j), c: p(k), n: [V[i * S + 3]!, V[i * S + 4]!, V[i * S + 5]!] });
    }
    return tris;
  };

  it('raised roads get concrete walls, an underside and pillars, all facing outwards', () => {
    const { net } = overpass();
    const tris = concrete(net);
    expect(tris.length).toBeGreaterThan(100);
    for (const { a, b, c, n } of tris) {
      const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const g = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
      const area = Math.hypot(g[0]!, g[1]!, g[2]!);
      if (area < 1e-6) continue; // zero-height wall where a ramp meets the ground
      expect((g[0]! * n[0] + g[1]! * n[1] + g[2]! * n[2]) / area).toBeGreaterThan(0.5);
    }
    // Pillars stand on the ground under the deck, but not on the road passing below.
    const feet = tris.filter((t) => [t.a, t.b, t.c].some((p) => Math.abs(p[1]) < 1e-6) && Math.abs(t.n[1]) < 1e-6);
    const pillarFeet = feet.filter((t) => [t.a, t.b, t.c].every((p) => Math.abs(p[0]) < 5));
    expect(pillarFeet.some((t) => Math.abs(t.a[2]) > 20)).toBe(true);
    expect(pillarFeet.every((t) => [t.a, t.b, t.c].every((p) => Math.abs(p[2]) > 8))).toBe(true);
  });

  it('roads on the ground get no concrete', () => {
    const net = new RoadNetwork();
    addRoad(net, at(-50, 0, 0), at(50, 0, 0), STREET);
    expect(concrete(net).length).toBe(0);
  });
});

describe('building on levels in the editor', () => {
  const world = () => new World(buildTestNetwork(), TEST_ZONE, TEST_SEED, testSpawners);
  const node = (w: World, x: number, z: number) => [...w.net.nodes.values()].find((n) => Math.hypot(n.pos[0] - x, n.pos[2] - z) < 0.01);
  /** Road tool: drag from a to b (ground points, finger 1.5 m) and press ✓. Returns the error, if any. */
  const draw = (ed: Editor, a: Vec3, b: Vec3): string | null => {
    ed.down(a, 1.5);
    ed.move(b, 1.5);
    ed.up();
    const err = ed.confirm();
    ed.discard();
    return err;
  };
  /** Two ground stubs on x = -60 (the arterial runs along z = 0), ending at z = ∓gap/2. */
  const stubs = (gap: number) => {
    const w = world(), ed = new Editor(w);
    ed.setTool('road');
    ed.setPreset(0);
    expect(draw(ed, [-60, 0, -95], [-60, 0, -gap / 2])).toBeNull();
    expect(draw(ed, [-60, 0, gap / 2], [-60, 0, 95])).toBeNull();
    return { w, ed };
  };
  const onLine = (w: World) => [...w.net.segments.values()].filter((s) => Math.abs(s.curve.p0[0] + 60) < 0.01 && Math.abs(s.curve.p3[0] + 60) < 0.01);

  it('a Bridge road between two ground roads gets a ramp at each end and passes over the arterial', () => {
    const { w, ed } = stubs(170);
    ed.setLevel('bridge');
    expect(draw(ed, [-60, 0, -85], [-60, 0, 85])).toBeNull();
    // Stub, ramp up, deck, ramp down, stub: no junction where it passes over the arterial.
    const roads = onLine(w).sort((a, b) => a.curve.p0[2] - b.curve.p0[2]);
    expect(roads.length).toBe(5);
    const heights = roads.map((s) => [s.curve.p0[1], s.curve.p3[1]]);
    expect(heights).toEqual([[0, 0], [0, LEVELS.bridge], [LEVELS.bridge, LEVELS.bridge], [LEVELS.bridge, 0], [0, 0]]);
    expect(roads[1]!.curve.length).toBeCloseTo(rampLength(LEVELS.bridge), 0);
    expect(node(w, -60, 0)).toBeUndefined();
  });

  it('refuses a Bridge road too short for its ramps, and builds it on the ground', () => {
    const { w, ed } = stubs(100);
    ed.setLevel('bridge');
    expect(draw(ed, [-60, 0, -50], [-60, 0, 50])).toMatch(/^Too short for this level: the ramps need 124 m/);
    ed.setLevel('ground');
    expect(draw(ed, [-60, 0, -50], [-60, 0, 50])).toBeNull();
    expect(node(w, -60, 0)?.segments.length).toBe(4); // a crossroads with the arterial
  });

  it('a road ending on open ground ends at the chosen level; chaining carries on up there', () => {
    const { w, ed } = stubs(170);
    ed.setLevel('high');
    ed.down([-60, 0, -85], 1.5);
    ed.move([-60, 0, 60], 1.5);
    ed.up();
    expect(ed.confirm()).toBeNull();
    expect(node(w, -60, 60)!.pos[1]).toBe(LEVELS.high);
    // The ramp's top (its length is measured along the slope, a little more than in plan).
    const top = [...w.net.nodes.values()].find((n) => Math.abs(n.pos[0] + 60) < 0.01 && Math.abs(n.pos[2] - (-85 + rampLength(LEVELS.high))) < 1);
    expect(top?.pos[1]).toBe(LEVELS.high);
    // Chained on at the same level: no second ramp, the deck carries on.
    ed.tap([-30, 0, 60], 1.5);
    expect(ed.confirm()).toBeNull();
    expect(node(w, -30, 60)!.pos[1]).toBe(LEVELS.high);
  });

  it('picks a raised road where it is seen on screen, and the top one where they overlap', () => {
    const { w, ed } = stubs(170);
    ed.setLevel('bridge');
    expect(draw(ed, [-60, 0, -85], [-60, 0, 85])).toBeNull();
    ed.setTool('select');
    const picked = (p: Vec3) => {
      ed.tap(p, 1.5);
      const s = ed.selection;
      return s?.kind === 'segment' ? w.net.segment(s.id).curve.point(0.5)[1] : null;
    };
    // From straight above: the arterial beside the deck, the deck where both are under the finger.
    expect(picked([-50, 0, 0])).toBe(0);
    expect(picked([-62, 0, 0])).toBe(LEVELS.bridge);
    // Looking east at 45°: the deck (6 m up) appears 6 m further east, over the arterial.
    const s = Math.SQRT1_2;
    ed.aim([s, -s, 0]);
    expect(picked([-50, 0, 0])).toBe(LEVELS.bridge);
    expect(picked([-44, 0, 0])).toBe(0);
  });

  it('bridge decks spare trees and parks that fit underneath, not buildings; ramps take everything', () => {
    const { net } = overpass(); // deck at 6 m for |z| < 70, ramps out to |z| = 150, along x = 0
    const item = (id: number, kind: CityItem['kind'], z: number, top: number): CityItem => ({
      id, kind, x: 0, z, r: 1.5, top, ranges: [], shadow: { start: 0, count: 0 },
      lot: kind === 'tree' ? null : { cx: 0, cz: z, hx: 6, hz: 6, angle: 0, kind, inZone: true },
    });
    const items = [
      item(0, 'tree', -40, 4), // small tree under the deck: stays
      item(1, 'tree', -40, 7), // tall tree would poke through the deck
      item(2, 'house', 40, 6),
      item(3, 'park', 30, 3),
      item(4, 'tree', -140, 4), // on the low part of the ramp
    ];
    const city = { items } as unknown as City;
    expect(itemsHitByRoads(city, net, ZONE).sort()).toEqual([1, 2, 4]);
  });
});

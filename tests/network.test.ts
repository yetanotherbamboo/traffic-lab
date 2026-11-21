import { describe, expect, it } from 'vitest';
import { buildTestNetwork } from '../src/game/testScene';
import { CubicBezier } from '../src/network/bezier';
import { RoadNetwork } from '../src/network/network';
import { ROAD_STRIDE, buildRoadMesh } from '../src/render/roadMesh';

describe('CubicBezier', () => {
  it('measures a straight line exactly', () => {
    const c = CubicBezier.line([0, 0, 0], [30, 0, 40]);
    expect(c.length).toBeCloseTo(50, 6);
    const mid = c.point(c.tAtDistance(25));
    expect(mid[0]).toBeCloseTo(15, 3);
    expect(mid[2]).toBeCloseTo(20, 3);
  });

  it('approximates a quarter circle within 0.5%', () => {
    const r = 100, k = 0.5523 * r; // standard cubic circle approximation
    const c = new CubicBezier([r, 0, 0], [r, 0, k], [k, 0, r], [0, 0, r]);
    expect(Math.abs(c.length - (Math.PI / 2) * r) / ((Math.PI / 2) * r)).toBeLessThan(0.005);
  });

  it('samples at roughly constant speed', () => {
    const c = new CubicBezier([0, 0, 0], [80, 0, 0], [100, 0, 20], [100, 0, 100]);
    const pts = [0, 0.25, 0.5, 0.75, 1].map((f) => c.point(c.tAtDistance(f * c.length)));
    for (let i = 1; i < pts.length; i++) {
      const d = Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![2] - pts[i - 1]![2]);
      expect(d / (c.length / 4)).toBeGreaterThan(0.97);
    }
  });
});

describe('RoadNetwork', () => {
  it('trims roads at junctions and orders arms by angle', () => {
    const net = new RoadNetwork();
    const p = { forward: 1, backward: 1, laneWidth: 3, sidewalk: 2 };
    const c = net.addNode([0, 0, 0]);
    const ids = [[100, 0], [0, 100], [-100, 0]].map(([x, z]) => net.addNode([x!, 0, z!]));
    ids.forEach((id) => net.addSegment(c, id, p));
    expect(net.isJunction(c)).toBe(true);
    const r = net.junctionRadius(c);
    const arms = net.arms(c);
    expect(arms).toHaveLength(3);
    for (const a of arms) expect(Math.hypot(a.end[0], a.end[2])).toBeCloseTo(r, 3);
    expect(arms.map((a) => a.angle)).toEqual([...arms.map((a) => a.angle)].sort((x, y) => x - y));
  });
});

describe('buildRoadMesh', () => {
  it('produces valid indexed geometry for the test scene', () => {
    const mesh = buildRoadMesh(buildTestNetwork());
    const vcount = mesh.vertices.length / ROAD_STRIDE;
    expect(vcount).toBeGreaterThan(100);
    expect(mesh.indices.length % 3).toBe(0);
    for (const i of mesh.indices) expect(i).toBeLessThan(vcount);
    for (const v of mesh.vertices) expect(Number.isFinite(v)).toBe(true);
  });

  it('compact junctions of small roads face upwards and are smaller', () => {
    const ALLEY = { forward: 1, backward: 1, laneWidth: 2.75, sidewalk: 1, speedLimit: 30 };
    const STREET = { forward: 1, backward: 1, laneWidth: 3.25, sidewalk: 2.5, speedLimit: 40 };
    const LANE = { forward: 1, backward: 0, laneWidth: 3, sidewalk: 1.5, speedLimit: 30 };
    const radius = (side: typeof STREET, arms: [number, number][]) => {
      const net = new RoadNetwork();
      const c = net.addNode([0, 0, 0]);
      arms.forEach(([x, z], k) => net.addSegment(c, net.addNode([x, 0, z]), k < 2 ? STREET : side));
      const mesh = buildRoadMesh(net);
      const V = mesh.vertices, S = ROAD_STRIDE;
      for (let t = 0; t < mesh.indices.length; t += 3) {
        const [a, b, d] = [mesh.indices[t]!, mesh.indices[t + 1]!, mesh.indices[t + 2]!];
        if (V[a * S + 4]! < 0.99) continue;
        const e1 = [V[b * S]! - V[a * S]!, V[b * S + 2]! - V[a * S + 2]!], e2 = [V[d * S]! - V[a * S]!, V[d * S + 2]! - V[a * S + 2]!];
        expect(e1[1]! * e2[0]! - e1[0]! * e2[1]!).toBeGreaterThanOrEqual(-1e-6);
      }
      return net.junctionRadius(c);
    };
    const T: [number, number][] = [[50, 0], [-50, 0], [0, 50]];
    const street = radius(STREET, T), lane = radius(LANE, T), alley = radius(ALLEY, T);
    expect(lane).toBeLessThan(street - 1);
    expect(alley).toBeLessThan(street - 1);
    // Four alleys: a compact crossroads.
    const net = new RoadNetwork();
    const c = net.addNode([0, 0, 0]);
    for (const [x, z] of [[40, 0], [-40, 0], [0, 40], [0, -40]] as [number, number][]) net.addSegment(c, net.addNode([x, 0, z]), ALLEY);
    expect(net.junctionRadius(c)).toBeLessThan(6);
  });

  it('road surfaces face upwards', () => {
    const mesh = buildRoadMesh(buildTestNetwork());
    const V = mesh.vertices, S = ROAD_STRIDE;
    for (let t = 0; t < mesh.indices.length; t += 3) {
      const [a, b, c] = [mesh.indices[t]!, mesh.indices[t + 1]!, mesh.indices[t + 2]!];
      if (V[a * S + 4]! < 0.99) continue; // only check triangles with up normals
      const e1 = [V[b * S]! - V[a * S]!, V[b * S + 2]! - V[a * S + 2]!];
      const e2 = [V[c * S]! - V[a * S]!, V[c * S + 2]! - V[a * S + 2]!];
      const ny = e1[1]! * e2[0]! - e1[0]! * e2[1]!; // y of cross(e1, e2)
      expect(ny).toBeGreaterThanOrEqual(-1e-6);
    }
  });
});

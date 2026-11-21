import { describe, expect, it } from 'vitest';
import { buildTestNetwork } from '../src/game/testScene';
import type { Vec3 } from '../src/core/math';
import { CubicBezier } from '../src/network/bezier';
import { RoadNetwork } from '../src/network/network';
import { MAT_ASPHALT, ROAD_STRIDE, buildRoadMesh } from '../src/render/roadMesh';

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
    // One-way lanes on an avenue at many angles (the empty side of a lane has its kerb on the centreline).
    for (const deg of [30, 45, 60, 75, 105, 120, 135, 150]) {
      const h = (deg * Math.PI) / 180;
      const AVENUE = { forward: 2, backward: 2, laneWidth: 3.5, sidewalk: 2.5, speedLimit: 50 };
      for (const side of [LANE, { ...LANE, forward: 0, backward: 1 }]) {
        const net = new RoadNetwork();
        const c = net.addNode([0, 0, 0]);
        net.addSegment(net.addNode([-50, 0, 0]), c, AVENUE);
        net.addSegment(c, net.addNode([50, 0, 0]), AVENUE);
        net.addSegment(c, net.addNode([Math.cos(h) * 40, 0, Math.sin(h) * 40]), side);
        const mesh = buildRoadMesh(net);
        const V = mesh.vertices, S = ROAD_STRIDE;
        for (let t = 0; t < mesh.indices.length; t += 3) {
          const [a, b, d] = [mesh.indices[t]!, mesh.indices[t + 1]!, mesh.indices[t + 2]!];
          if (V[a * S + 4]! < 0.99) continue;
          const e1 = [V[b * S]! - V[a * S]!, V[b * S + 2]! - V[a * S + 2]!], e2 = [V[d * S]! - V[a * S]!, V[d * S + 2]! - V[a * S + 2]!];
          expect(e1[1]! * e2[0]! - e1[0]! * e2[1]!, `lane at ${deg}°`).toBeGreaterThanOrEqual(-1e-4);
        }
      }
    }
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

  it('entrances face upwards and are smaller than a full junction', () => {
    const STREET = { forward: 1, backward: 1, laneWidth: 3.25, sidewalk: 2.5, speedLimit: 40 };
    const AVENUE = { forward: 2, backward: 2, laneWidth: 3.5, sidewalk: 2.5, speedLimit: 50 };
    const sides: { forward: number; backward: number; laneWidth: number; sidewalk: number; speedLimit: number }[] = [
      { forward: 1, backward: 0, laneWidth: 3, sidewalk: 1.5, speedLimit: 30 },
      { forward: 0, backward: 1, laneWidth: 3, sidewalk: 1.5, speedLimit: 30 },
      { forward: 1, backward: 1, laneWidth: 2.75, sidewalk: 1, speedLimit: 30 },
      STREET,
    ];
    for (const main of [STREET, AVENUE]) for (const side of sides) for (const deg of [70, 75, 80, 90, 100, 105, 110, -70, -90, -110]) {
      const net = new RoadNetwork();
      const c = net.addNode([0, 0, 0]);
      net.addSegment(net.addNode([-50, 0, 0]), c, main);
      net.addSegment(c, net.addNode([50, 0, 0]), main);
      const h = (deg * Math.PI) / 180;
      net.addSegment(c, net.addNode([Math.cos(h) * 40, 0, Math.sin(h) * 40]), side);
      const full = net.junctionRadius(c);
      net.node(c).entrance = true;
      expect(net.isEntrance(c), `${deg}°`).toBe(true);
      if (Math.abs(deg) === 90) expect(net.junctionRadius(c)).toBeLessThanOrEqual(full + 1e-6);
      // No overlap: the side road starts clear of the through road (lanes and sidewalk), and the
      // through road's arms stop clear of the side road.
      const M = main.forward * main.laneWidth + main.sidewalk; // symmetric main roads here
      for (const arm of net.arms(c)) {
        const sideArm = arm.segment.profile === side;
        for (const k of [1, -1]) {
          const ext = (k > 0 ? arm.rightExt : arm.leftExt) + arm.segment.profile.sidewalk;
          const p = [arm.end[0] + arm.right[0] * ext * k, arm.end[2] + arm.right[2] * ext * k];
          if (sideArm) {
            expect(Math.abs(p[1]!), `side corner clears the through road at ${deg}°`).toBeGreaterThanOrEqual(M - 1e-6);
          } else if (Math.sign(p[1]!) === Math.sign(Math.sin(h))) {
            // Distance from the side road's centreline must exceed its half width on that side.
            // The side road leaves the node (it runs c → end): forward lanes on its right.
            const r = -p[0]! * Math.sin(h) + p[1]! * Math.cos(h);
            const along = p[0]! * Math.cos(h) + p[1]! * Math.sin(h);
            const e = (r > 0 ? side.forward : side.backward) * side.laneWidth + side.sidewalk;
            if (along > 0) expect(Math.abs(r), `through-road corner clears the side road at ${deg}°`).toBeGreaterThanOrEqual(e - 1e-6);
          }
        }
      }
      const mesh = buildRoadMesh(net);
      const V = mesh.vertices, S = ROAD_STRIDE;
      for (let t = 0; t < mesh.indices.length; t += 3) {
        const [a, b, d] = [mesh.indices[t]!, mesh.indices[t + 1]!, mesh.indices[t + 2]!];
        if (V[a * S + 4]! < 0.99) continue;
        const e1 = [V[b * S]! - V[a * S]!, V[b * S + 2]! - V[a * S + 2]!], e2 = [V[d * S]! - V[a * S]!, V[d * S + 2]! - V[a * S + 2]!];
        expect(e1[1]! * e2[0]! - e1[0]! * e2[1]!).toBeGreaterThanOrEqual(-1e-4); // zero-area slivers allowed
      }
    }
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

describe('junctions with curved arms', () => {
  it('pull curved roads back far enough that they do not overlap their neighbours', () => {
    const p = { forward: 1, backward: 1, laneWidth: 3.25, sidewalk: 2.5, speedLimit: 40 };
    const half = 3.25 + 2.5;
    for (const bendIn of [8, 12, 15]) {
      const net = new RoadNetwork();
      const o = net.addNode([0, 0, 0]);
      const east = net.addSegment(o, net.addNode([60, 0, 0]), p);
      net.addSegment(o, net.addNode([-60, 0, 0]), p);
      // Leaves at 60° and swings back towards the east road.
      const arm = net.addSegment(o, net.addNode([60, 0, bendIn + 2 * half]), p, [5, 0, 8.66], [30, 0, bendIn + 2 * half]);
      const drawn = (id: number) => {
        const seg = net.segment(id);
        const [s0, s1] = net.trimmedRange(seg);
        const pts: Vec3[] = [];
        for (let s = s0; s <= s1; s += 0.5) pts.push(seg.curve.point(seg.curve.tAtDistance(s)));
        return pts;
      };
      const a = drawn(arm), e = drawn(east);
      let gap = Infinity;
      for (const q of a) for (const r of e) gap = Math.min(gap, Math.hypot(q[0] - r[0], q[2] - r[2]));
      expect(gap, `bend ${bendIn}`).toBeGreaterThan(2 * half - 0.3);
    }
  });

  it('keep straight junctions as they were', () => {
    const p = { forward: 1, backward: 1, laneWidth: 3.25, sidewalk: 2.5, speedLimit: 40 };
    const net = new RoadNetwork();
    const o = net.addNode([0, 0, 0]);
    const s1 = net.addSegment(o, net.addNode([60, 0, 0]), p);
    net.addSegment(o, net.addNode([-60, 0, 0]), p);
    const s3 = net.addSegment(o, net.addNode([30, 0, 51.96]), p); // straight at 60°
    // Straight-line edge meeting point: the corner fillet room on top of it.
    const d = (3.25 + 2.5) / Math.sin(Math.PI / 3) + (3.25 + 2.5) / Math.tan(Math.PI / 3);
    expect(net.armTrim(o, s1)).toBeCloseTo(d + 3, 3);
    expect(net.armTrim(o, s3)).toBeCloseTo(d + 3, 3);
  });
});

describe('bends between roads (2-road junctions)', () => {
  const AVENUE = { forward: 2, backward: 2, laneWidth: 3.5, sidewalk: 2.5, speedLimit: 50 };
  const STREET = { forward: 1, backward: 1, laneWidth: 3.25, sidewalk: 2.5, speedLimit: 40 };
  const ONEWAY = { forward: 2, backward: 0, laneWidth: 3.25, sidewalk: 2, speedLimit: 40 };
  const bend = (deg: number, pa: typeof AVENUE, pb: typeof AVENUE) => {
    const net = new RoadNetwork();
    const o = net.addNode([0, 0, 0]);
    net.addSegment(o, net.addNode([-60, 0, 0]), pa);
    const r = (deg * Math.PI) / 180;
    net.addSegment(o, net.addNode([-60 * Math.cos(r), 0, 60 * Math.sin(r)]), pb);
    return buildRoadMesh(net);
  };
  /** Area (m²) of plain-asphalt triangles, and how many triangles face down. */
  const inspect = (mesh: ReturnType<typeof buildRoadMesh>) => {
    const V = mesh.vertices, I = mesh.indices, S = ROAD_STRIDE;
    let area = 0, flipped = 0;
    for (let t = 0; t < I.length; t += 3) {
      const [a, b, c] = [I[t]!, I[t + 1]!, I[t + 2]!];
      const cross = (V[b * S + 2]! - V[a * S + 2]!) * (V[c * S]! - V[a * S]!) - (V[b * S]! - V[a * S]!) * (V[c * S + 2]! - V[a * S + 2]!);
      if (V[a * S + 4]! >= 0.99 && cross < -1e-6) flipped++;
      if (Math.round(V[a * S + 11]!) === MAT_ASPHALT) area += Math.abs(cross) / 2;
    }
    return { area, flipped };
  };

  it('the outside of a bend is a squared-off kerb with a small rounding, not a big round blob', () => {
    // Before: 410 m² (90°) and 880 m² (60°) for an avenue turning into a street.
    expect(inspect(bend(90, AVENUE, STREET)).area).toBeLessThan(250);
    expect(inspect(bend(60, AVENUE, STREET)).area).toBeLessThan(400);
    expect(inspect(bend(90, AVENUE, AVENUE)).area).toBeLessThan(400);
  });

  it('bends of every angle and width face upwards', () => {
    for (let deg = 30; deg <= 175; deg += 5) {
      for (const [pa, pb] of [[AVENUE, STREET], [STREET, AVENUE], [AVENUE, AVENUE], [ONEWAY, STREET], [STREET, ONEWAY]] as const) {
        expect(inspect(bend(deg, pa, pb)).flipped, `${deg}°`).toBe(0);
      }
    }
  });
});

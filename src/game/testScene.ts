import { type LaneProfile, RoadNetwork } from '../network/network';

const ARTERIAL: LaneProfile = { forward: 2, backward: 2, laneWidth: 3.5, sidewalk: 2.5 };
const LOCAL: LaneProfile = { forward: 1, backward: 1, laneWidth: 3.25, sidewalk: 2.5 };
const ONE_WAY: LaneProfile = { forward: 2, backward: 0, laneWidth: 3.25, sidewalk: 2 };

/** Hand-built network for Milestone 2: a 4-way cross, a T-junction with a curved road, a one-way. */
export function buildTestNetwork(): RoadNetwork {
  const net = new RoadNetwork();
  const c = net.addNode([0, 0, 0]);
  const w = net.addNode([-160, 0, 0]);
  const e = net.addNode([140, 0, 0]);
  const n = net.addNode([0, 0, -160]);
  const s = net.addNode([0, 0, 150]);
  net.addSegment(w, c, ARTERIAL);
  net.addSegment(c, e, ARTERIAL);
  net.addSegment(c, n, LOCAL);
  net.addSegment(s, c, LOCAL);

  // T-junction at the east end: a curved road heading north-east and a straight one south.
  const ne = net.addNode([230, 0, -110]);
  net.addSegment(e, ne, LOCAL, [195, 0, 0], [230, 0, -50]);
  const se = net.addNode([140, 0, 150]);
  net.addSegment(e, se, LOCAL);

  // One-way street closing the south side into a loop.
  net.addSegment(se, s, ONE_WAY);
  return net;
}

/** Placeholder blocks in the gaps between roads (replaced by procedural buildings in Milestone 2b). */
export function testBoxes(): Float32Array {
  const palette = [
    [0.95, 0.78, 0.62], [0.78, 0.86, 0.93], [0.96, 0.9, 0.7],
    [0.85, 0.75, 0.88], [0.98, 0.7, 0.6], [0.75, 0.88, 0.78],
  ];
  const out: number[] = [];
  let i = 0;
  for (let x = -140; x <= 120; x += 26) {
    for (let z = -140; z <= 125; z += 26) {
      if (Math.abs(x) < 22 || Math.abs(z) < 22) continue; // keep clear of the cross roads
      if (x > 100 && z > -20) continue; // clear of the T-junction area
      if (z > 120) continue; // clear of the one-way street
      const c = palette[i % palette.length]!;
      const h = 4 + ((i * 7) % 5) * 4;
      out.push(x, 0, z, 0, 14 + (i % 3) * 2, h, 14, c[0]!, c[1]!, c[2]!);
      i++;
    }
  }
  return new Float32Array(out);
}

import type { Zone } from '../env/zone';
import { type LaneProfile, RoadNetwork } from '../network/network';
import type { Spawner } from '../sim/traffic';

const ARTERIAL: LaneProfile = { forward: 2, backward: 2, laneWidth: 3.5, sidewalk: 2.5, speedLimit: 50 };
const LOCAL: LaneProfile = { forward: 1, backward: 1, laneWidth: 3.25, sidewalk: 2.5, speedLimit: 40 };
const ONE_WAY: LaneProfile = { forward: 2, backward: 0, laneWidth: 3.25, sidewalk: 2, speedLimit: 40 };

/** Synthetic demand: every road leaving the scene is an origin and a destination. */
export function testSpawners(net: RoadNetwork): Spawner[] {
  const out: Spawner[] = [];
  for (const node of net.nodes.values()) {
    if (node.segments.length !== 1) continue;
    const seg = net.segments.get(node.segments[0]!)!;
    const lanes = Math.max(seg.profile.forward, seg.profile.backward);
    out.push({ node: node.id, rate: lanes >= 2 ? 900 : 340 });
  }
  return out;
}

/** Buildable area (200 m square) around the central crossroad, short of the ring street; the visible city extends 1.9 times as far. */
export const TEST_ZONE: Zone = { cx: 0, cz: 0, hx: 100, hz: 100, radius: 40, contextScale: 1.9 };
export const TEST_SEED = 20261119;

/**
 * A small city patch: a central 4-way cross (inside the construction zone), a ring of
 * local streets with a curved corner and a one-way stretch, and arterials leaving the scene.
 */
export function buildTestNetwork(): RoadNetwork {
  const net = new RoadNetwork();
  const R = 150; // ring street distance from the centre
  const c = net.addNode([0, 0, 0]);
  const w = net.addNode([-R, 0, 0]);
  const e = net.addNode([R, 0, 0]);
  const n = net.addNode([0, 0, -R]);
  const s = net.addNode([0, 0, R]);
  net.addSegment(w, c, ARTERIAL);
  net.addSegment(c, e, ARTERIAL);
  net.addSegment(c, n, LOCAL);
  net.addSegment(s, c, LOCAL);

  // Ring of local streets. The north-east corner is a sweeping curve instead of a node.
  const nw = net.addNode([-R, 0, -R]);
  const se = net.addNode([R, 0, R]);
  const sw = net.addNode([-R, 0, R]);
  net.addSegment(w, nw, LOCAL);
  net.addSegment(nw, n, LOCAL);
  net.addSegment(n, e, LOCAL, [R * 0.5, 0, -R], [R, 0, -R * 0.5]);
  net.addSegment(e, se, LOCAL);
  net.addSegment(se, s, LOCAL);
  net.addSegment(s, sw, ONE_WAY);
  net.addSegment(sw, w, LOCAL);

  // Roads continuing out of the scene so the city reads as part of something bigger.
  const out = 270;
  net.addSegment(w, net.addNode([-out, 0, 0]), ARTERIAL);
  net.addSegment(e, net.addNode([out, 0, 0]), ARTERIAL);
  net.addSegment(n, net.addNode([0, 0, -out]), LOCAL);
  net.addSegment(s, net.addNode([0, 0, out]), LOCAL);
  net.addSegment(nw, net.addNode([-out, 0, -R]), LOCAL);
  net.addSegment(sw, net.addNode([-R, 0, out]), LOCAL);

  // Junction control: signals at the main cross, an all-way stop to the north, priority elsewhere.
  net.node(c).control = 'signal';
  net.node(n).control = 'allway';
  return net;
}

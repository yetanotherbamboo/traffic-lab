import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../src/core/math';
import { setControl, setFreeFlow, setTurns } from '../src/editor/ops';
import { lotsOverlap } from '../src/env/city';
import { type JunctionControl, type LaneProfile, RoadNetwork, TURN_RIGHT, TURN_STRAIGHT } from '../src/network/network';
import { JunctionProps } from '../src/render/junctionProps';
import { LaneGraph } from '../src/sim/laneGraph';
import { TrafficSim } from '../src/sim/traffic';

const STREET: LaneProfile = { forward: 1, backward: 1, laneWidth: 3.25, sidewalk: 2.5, speedLimit: 40 };
const AVENUE: LaneProfile = { forward: 2, backward: 2, laneWidth: 3.5, sidewalk: 2.5, speedLimit: 50 };
/** One-way towards the junction / away from it (segments run junction → dead end). */
const ONE_WAY_IN: LaneProfile = { forward: 0, backward: 1, laneWidth: 3.25, sidewalk: 2, speedLimit: 40 };
const ONE_WAY_OUT: LaneProfile = { forward: 1, backward: 0, laneWidth: 3.25, sidewalk: 2, speedLimit: 40 };

/**
 * A T-junction at the origin: the main road runs west–east, the side road leaves towards +z, so
 * eastbound traffic drives on the side-road side and westbound traffic on the far side.
 */
function tee(main: LaneProfile, side: LaneProfile) {
  const net = new RoadNetwork();
  const c = net.addNode([0, 0, 0]);
  const east = net.addNode([200, 0, 0]), west = net.addNode([-200, 0, 0]), south = net.addNode([0, 0, 200]);
  const eastSeg = net.addSegment(c, east, main);
  const westSeg = net.addSegment(c, west, main);
  const sideSeg = net.addSegment(c, south, side);
  return { net, centre: c, ends: [east, west, south], eastSeg, westSeg, sideSeg };
}

/** Road lanes of `seg` arriving at `node`. */
const arriving = (g: LaneGraph, seg: number, node: number): number[] =>
  g.lanes.filter((l) => l.kind === 'road' && l.segment === seg && l.toNode === node).map((l) => l.id);

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

/** Side road comes in one-way and may only turn right: the far (westbound) lane crosses nobody. */
function rightInTee() {
  const t = tee(STREET, ONE_WAY_IN);
  setTurns(t.net, t.sideSeg, t.centre, 0, TURN_RIGHT);
  return t;
}

/** Runs 10 minutes of traffic; returns collisions and seconds vehicles on `lanes` spent held. */
function run(net: RoadNetwork, ends: number[], lanes: (g: LaneGraph) => number[]) {
  const graph = new LaneGraph(net);
  const sim = new TrafficSim(graph, ends.map((node) => ({ node, rate: 400 })), 11);
  const watch = new Set(lanes(graph));
  let collisions = 0, held = 0, heldElsewhere = 0;
  for (let t = 1; t <= 6000; t++) {
    sim.step(0.1);
    for (let i = 0; i < sim.capacity; i++) {
      if (!sim.alive[i] || !sim.waiting[i]) continue;
      if (watch.has(sim.lane[i]!)) held += 0.1;
      else heldElsewhere += 0.1;
    }
    if (t % 2 === 0) collisions += overlaps(sim);
  }
  return { collisions, held, heldElsewhere, exited: sim.stats.exited, sim };
}

describe('non-stop lanes', () => {
  it('finds the lanes that cross and merge with no other traffic', () => {
    // A plain T: every lane meets someone (the left turns cross both directions).
    const plain = tee(STREET, STREET);
    expect(new TrafficSim(new LaneGraph(plain.net), [], 1).junctions.nonStop.get(plain.centre)).toEqual([]);

    // Right turn in only: the far lane is free, the near lane (which they merge into) is not.
    const a = rightInTee();
    const ga = new LaneGraph(a.net);
    expect(new TrafficSim(ga, [], 1).junctions.nonStop.get(a.centre)).toEqual(arriving(ga, a.eastSeg, a.centre));

    // One-way road branching off, far lane may not turn into it: both main-road lanes are free
    // (the near lane's right turn just peels off).
    const b = tee(STREET, ONE_WAY_OUT);
    setTurns(b.net, b.eastSeg, b.centre, 0, TURN_STRAIGHT);
    const gb = new LaneGraph(b.net);
    expect(new TrafficSim(gb, [], 1).junctions.nonStop.get(b.centre)!.sort()).toEqual(
      [...arriving(gb, b.eastSeg, b.centre), ...arriving(gb, b.westSeg, b.centre)].sort());
  });

  it('is off until turned on, and survives saving (undo snapshots)', () => {
    const a = rightInTee();
    const g = new LaneGraph(a.net);
    const sim = new TrafficSim(g, [], 1);
    expect([...sim.junctions.free].some((f) => f === 1)).toBe(false);
    setFreeFlow(a.net, a.centre, true);
    const copy = a.net.clone();
    expect(copy.node(a.centre).freeFlow).toBe(true);
    const g2 = new LaneGraph(copy);
    const j = new TrafficSim(g2, [], 1).junctions;
    const lane = arriving(g2, a.eastSeg, a.centre)[0]!;
    expect(j.free[lane]).toBe(1);
    for (const c of g2.lanes[lane]!.next) expect(j.free[c]).toBe(1);
    setFreeFlow(copy, a.centre, false);
    expect(copy.toData().nodes.find((n) => n.id === a.centre)!.freeFlow).toBeUndefined();
  });

  for (const control of ['signal', 'allway'] as JunctionControl[]) {
    it(`the free lane drives through a ${control} junction without stopping, safely`, () => {
      const far = (t: ReturnType<typeof rightInTee>) => (g: LaneGraph) => arriving(g, t.eastSeg, t.centre);
      const off = rightInTee();
      setControl(off.net, off.centre, control);
      const before = run(off.net, off.ends, far(off));
      expect(before.held, 'the far lane stops while non-stop lanes are off').toBeGreaterThan(30);

      const on = rightInTee();
      setControl(on.net, on.centre, control);
      setFreeFlow(on.net, on.centre, true);
      const after = run(on.net, on.ends, far(on));
      expect(after.collisions, 'overlapping vehicles').toBe(0);
      expect(after.held, 'seconds held on the non-stop lane').toBe(0);
      expect(after.exited).toBeGreaterThan(before.exited * 0.95);
      if (control === 'signal') {
        // The signal only serves the lanes that stop: the far arm drops out of the phases.
        const phases = after.sim.junctions.signals.get(on.centre)!.phases;
        expect(phases.flatMap((p) => p.arms)).not.toContain(on.eastSeg);
      }
    });
  }

  it('queues on a non-stop lane back up through the junction without blocking anyone', () => {
    // The T at the origin (side road: right turn in only, signals) and, 35 m west, a busy all-way
    // stop whose queue backs up through the T on the westbound (non-stop) lane.
    const net = new RoadNetwork();
    const c = net.addNode([0, 0, 0]);
    const east = net.addNode([200, 0, 0]), south = net.addNode([0, 0, 200]), w = net.addNode([-35, 0, 0]);
    const far = net.addNode([-235, 0, 0]), wn = net.addNode([-35, 0, -200]), ws = net.addNode([-35, 0, 200]);
    const eastSeg = net.addSegment(c, east, STREET);
    net.addSegment(c, w, STREET);
    const side = net.addSegment(c, south, ONE_WAY_IN);
    for (const e of [far, wn, ws]) net.addSegment(w, e, STREET);
    setTurns(net, side, c, 0, TURN_RIGHT);
    setControl(net, c, 'signal');
    setControl(net, w, 'allway');
    setFreeFlow(net, c, true);
    const graph = new LaneGraph(net);
    const sim = new TrafficSim(graph, [
      { node: east, rate: 700 }, { node: south, rate: 300 }, { node: far, rate: 300 }, { node: wn, rate: 600 }, { node: ws, rate: 600 },
    ], 5);
    const freeConn = new Set(graph.lanes[arriving(graph, eastSeg, c)[0]!]!.next);
    const sideConn = new Set(graph.lanes.filter((l) => l.kind === 'road' && l.segment === side).flatMap((l) => l.next));
    const last = new Int32Array(sim.capacity).fill(-1);
    let collisions = 0, queuedInside = 0, held = 0, sideTurns = 0;
    for (let t = 1; t <= 6000; t++) {
      sim.step(0.1);
      for (let i = 0; i < sim.capacity; i++) {
        const ln = sim.alive[i] ? sim.lane[i]! : -1;
        if (ln !== last[i] && sideConn.has(ln)) sideTurns++;
        last[i] = ln;
        if (!sim.alive[i] || !freeConn.has(sim.lane[i]!)) continue;
        if (sim.v[i]! < 0.1) queuedInside += 0.1;
        if (sim.waiting[i]) held += 0.1;
      }
      if (t % 2 === 0) collisions += overlaps(sim);
    }
    expect(queuedInside, 'seconds cars stood in the junction on the non-stop lane').toBeGreaterThan(10);
    expect(held, 'the junction never holds them back').toBe(0);
    expect(collisions, 'overlapping vehicles').toBe(0);
    // The side road keeps turning in past the queue (300 vehicles/h ≈ 50 in 10 min).
    expect(sideTurns).toBeGreaterThan(40);
  });

  it('multi-lane roads: only the free lanes skip the signal, the others still stop', () => {
    const t = tee(AVENUE, ONE_WAY_IN);
    setTurns(t.net, t.sideSeg, t.centre, 0, TURN_RIGHT);
    setControl(t.net, t.centre, 'signal');
    setFreeFlow(t.net, t.centre, true);
    const g = new LaneGraph(t.net);
    const j = new TrafficSim(g, [], 1).junctions;
    const far = arriving(g, t.eastSeg, t.centre), near = arriving(g, t.westSeg, t.centre);
    expect(far.every((id) => j.free[id] === 1)).toBe(true);
    // The right turn merges into the near kerb lane only, so the near inner lane is free as well.
    expect(near.map((id) => j.free[id])).toEqual([1, 0]);
    const res = run(t.net, t.ends, () => [...far, near[0]!]);
    expect(res.collisions).toBe(0);
    expect(res.held).toBe(0);
    expect(res.heldElsewhere).toBeGreaterThan(0);
  });

  it('paints the lane through the junction instead of a stop line', () => {
    const yellow = (net: RoadNetwork): number => {
      const p = new JunctionProps(new TrafficSim(new LaneGraph(net), [], 1));
      const n = p.update();
      let k = 0;
      for (let i = 0; i < n; i++) {
        const o = i * 11;
        const at: Vec3 = [p.buffer[o]!, 0, p.buffer[o + 2]!];
        const paint = Math.abs(p.buffer[o + 7]! - 0.95) + Math.abs(p.buffer[o + 8]! - 0.78) + Math.abs(p.buffer[o + 9]! - 0.35) < 1e-3;
        if (paint && Math.hypot(at[0], at[2]) < 15) k++;
      }
      return k;
    };
    const t = rightInTee();
    setControl(t.net, t.centre, 'signal');
    expect(yellow(t.net)).toBe(0);
    setFreeFlow(t.net, t.centre, true);
    expect(yellow(t.net)).toBeGreaterThan(5);
  });
});

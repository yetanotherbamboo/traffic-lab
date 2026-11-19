import type { LaneGraph } from './laneGraph';

/** Minimal binary min-heap of [priority, value] pairs. */
class MinHeap {
  private readonly items: [number, number][] = [];

  get size(): number {
    return this.items.length;
  }

  push(p: number, v: number): void {
    const a = this.items;
    a.push([p, v]);
    let i = a.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (a[parent]![0] <= a[i]![0]) break;
      [a[parent], a[i]] = [a[i]!, a[parent]!];
      i = parent;
    }
  }

  pop(): [number, number] {
    const a = this.items;
    const top = a[0]!;
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l]![0] < a[m]![0]) m = l;
        if (r < a.length && a[r]![0] < a[m]![0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i]!, a[m]!];
        i = m;
      }
    }
    return top;
  }
}

/**
 * Fastest lane-level route (free-flow travel time) from any of `startLanes` to any of `goalLanes`.
 * Returns the sequence of lane ids, or null if unreachable.
 */
export function findRoute(graph: LaneGraph, startLanes: number[], goalLanes: number[]): Int32Array | null {
  const n = graph.lanes.length;
  const dist = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const goal = new Set(goalLanes);
  const heap = new MinHeap();
  for (const id of startLanes) {
    const l = graph.lanes[id]!;
    dist[id] = l.path.length / l.speedLimit;
    heap.push(dist[id]!, id);
  }
  while (heap.size > 0) {
    const [d, id] = heap.pop();
    if (d > dist[id]!) continue;
    if (goal.has(id)) {
      const route: number[] = [];
      for (let c = id; c !== -1; c = prev[c]!) route.push(c);
      return Int32Array.from(route.reverse());
    }
    for (const nx of graph.lanes[id]!.next) {
      const l = graph.lanes[nx]!;
      const nd = d + l.path.length / l.speedLimit;
      if (nd < dist[nx]!) {
        dist[nx] = nd;
        prev[nx] = id;
        heap.push(nd, nx);
      }
    }
  }
  return null;
}

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
 * Routing towards one destination for every lane at once:
 *  cost[l] = free-flow travel time (s) from the start of lane l to the destination (Infinity if unreachable),
 *  next[l] = the lane to take after l (-1 at the destination or if unreachable).
 * Vehicles follow `next` and may switch to a parallel lane at any time without replanning.
 */
export interface RouteTable {
  cost: Float64Array;
  next: Int32Array;
}

export function computeRouteTable(graph: LaneGraph, goalLanes: number[]): RouteTable {
  const n = graph.lanes.length;
  const cost = new Float64Array(n).fill(Infinity);
  const next = new Int32Array(n).fill(-1);
  const heap = new MinHeap();
  for (const id of goalLanes) {
    const l = graph.lanes[id]!;
    cost[id] = l.path.length / l.speedLimit;
    heap.push(cost[id]!, id);
  }
  // Reverse Dijkstra over `prev` links.
  while (heap.size > 0) {
    const [c, id] = heap.pop();
    if (c > cost[id]!) continue;
    for (const p of graph.lanes[id]!.prev) {
      const l = graph.lanes[p]!;
      const nc = c + l.path.length / l.speedLimit;
      if (nc < cost[p]!) {
        cost[p] = nc;
        next[p] = id;
        heap.push(nc, p);
      }
    }
  }
  return { cost, next };
}

/** Lane sequence from `start` following a route table (for tests and debugging). */
export function traceRoute(table: RouteTable, start: number, maxLen = 1000): number[] {
  const out = [start];
  for (let l = table.next[start]!; l >= 0 && out.length < maxLen; l = table.next[l]!) out.push(l);
  return out;
}

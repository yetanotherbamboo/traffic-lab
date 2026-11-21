import { type City, applyDemolition, generateCity, itemsHitByRoads } from '../env/city';
import type { Zone } from '../env/zone';
import { demolitionCost } from '../editor/cost';
import type { EditorHost } from '../editor/editor';
import { splitAtZone } from '../editor/rules';
import { type NetworkData, RoadNetwork } from '../network/network';
import { LaneGraph } from '../sim/laneGraph';
import { type Spawner, TrafficSim } from '../sim/traffic';

const SINK_TIME = 0.9; // s, demolished buildings sink into the ground

interface Snapshot {
  /** The city's seed: buildings and traffic. Restoring needs a world built with the same seed. */
  seed: number;
  net: NetworkData;
  demolished: number[];
  spent: number;
}

/**
 * The live game state: road network, city and traffic. Edits replace the network; the lane
 * graph and simulation are rebuilt and the running vehicles carried over, so traffic never
 * restarts. DOM- and WebGL-free; the app re-uploads meshes when `version` changes.
 */
export class World implements EditorHost {
  net!: RoadNetwork;
  graph!: LaneGraph;
  sim!: TrafficSim;
  city!: City;
  spawners!: Spawner[];
  seed!: number;
  readonly demolished = new Set<number>();
  /** Items currently sinking: id → seconds since demolition. */
  private readonly sinking = new Map<number, number>();
  spent = 0;
  /** Vehicles removed by the last edit (their road disappeared). */
  lastDropped = 0;
  /** Bumped when roads change; `cityVersion` when buildings change. */
  version = 0;
  cityVersion = 0;
  private edits = 0;

  constructor(net: RoadNetwork, readonly zone: Zone, seed: number, private readonly makeSpawners: (net: RoadNetwork) => Spawner[]) {
    this.regenerate(net, seed);
  }

  /** Replaces everything with a fresh starting network and a city grown from `seed` (no traffic yet). */
  regenerate(net: RoadNetwork, seed: number): void {
    splitAtZone(net, this.zone);
    this.seed = seed;
    this.net = net;
    this.spawners = this.makeSpawners(net);
    this.city = generateCity(net, this.zone, seed);
    this.graph = new LaneGraph(net);
    this.sim = new TrafficSim(this.graph, this.spawners, seed);
    this.demolished.clear();
    this.sinking.clear();
    this.spent = 0;
    this.edits = 0;
    this.lastDropped = 0;
    this.version++;
    this.cityVersion++;
  }

  network(): RoadNetwork {
    return this.net;
  }

  /** Items the live roads already touch (street trees stand on sidewalks): they may stay. */
  private standing: { version: number; ids: Set<number> } = { version: -1, ids: new Set() };

  /**
   * What the candidate's roads demolish: items on new road space, plus anything on asphalt or
   * inside a junction area (e.g. a street tree whose sidewalk became a lane when the road was
   * widened, or that stood next to a road that is now crossed).
   */
  demolition(candidate: RoadNetwork): { items: number[]; cost: number } {
    if (this.standing.version !== this.version) {
      this.standing = { version: this.version, ids: new Set(itemsHitByRoads(this.city, this.net, this.zone, 'roads')) };
    }
    const hit = new Set(itemsHitByRoads(this.city, candidate, this.zone, 'roads').filter((id) => !this.standing.ids.has(id)));
    for (const id of itemsHitByRoads(this.city, candidate, this.zone, 'junctions')) hit.add(id);
    for (const id of itemsHitByRoads(this.city, candidate, this.zone, 'asphalt')) hit.add(id);
    const items = [...hit].filter((id) => !this.demolished.has(id)).sort((a, b) => a - b);
    return { items, cost: demolitionCost(items.map((id) => this.city.items[id]!)) };
  }

  /** Makes `net` live, keeping traffic running. */
  private setNetwork(net: RoadNetwork): void {
    this.net = net;
    this.graph = new LaneGraph(net);
    const sim = new TrafficSim(this.graph, this.spawners, this.seed + ++this.edits);
    this.lastDropped = sim.adopt(this.sim);
    this.sim = sim;
    this.version++;
  }

  commit(net: RoadNetwork, items: number[], cost: number): void {
    for (const id of items) {
      this.demolished.add(id);
      this.sinking.set(id, 0);
    }
    if (items.length > 0) this.refreshCity();
    this.spent += cost;
    this.setNetwork(net);
  }

  snapshot(): Snapshot {
    return { seed: this.seed, net: this.net.toData(), demolished: [...this.demolished], spent: this.spent };
  }

  restore(s: unknown): void {
    const snap = s as Snapshot;
    if (snap.seed !== this.seed) throw new Error('Snapshot belongs to a city with another seed');
    this.demolished.clear();
    for (const id of snap.demolished) this.demolished.add(id);
    this.sinking.clear();
    this.spent = snap.spent;
    this.refreshCity();
    this.setNetwork(RoadNetwork.fromData(snap.net));
  }

  /** Advances the demolition animation; returns true while something is sinking. */
  animate(dt: number): boolean {
    if (this.sinking.size === 0) return false;
    for (const [id, t] of this.sinking) {
      if (t + dt >= SINK_TIME) this.sinking.delete(id);
      else this.sinking.set(id, t + dt);
    }
    this.refreshCity();
    return true;
  }

  private refreshCity(): void {
    const progress = new Map<number, number>();
    for (const [id, t] of this.sinking) progress.set(id, t / SINK_TIME);
    applyDemolition(this.city, this.demolished, progress);
    this.cityVersion++;
  }
}

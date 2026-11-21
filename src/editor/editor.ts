import type { Vec3 } from '../core/math';
import { type Zone, zoneDistance } from '../env/zone';
import type { LaneProfile, RoadNetwork } from '../network/network';
import { type EditResult, EditError, addRoad, anchorProblem, bendRoad, deleteRoad, touchedAround } from './ops';
import { type Pick, pickAt } from './pick';
import { removeRing, roundaboutAt, tidyRoundabouts } from './roundabout';
import { nodeConnectable, segmentEditable } from './rules';
import { type Anchor, snapPoint } from './snap';
import { validate } from './validate';

export type Tool = 'view' | 'road' | 'bend' | 'select' | 'delete';

export interface RoadPreset {
  name: string;
  profile: LaneProfile;
}

export const ROAD_PRESETS: RoadPreset[] = [
  { name: 'Street', profile: { forward: 1, backward: 1, laneWidth: 3.25, sidewalk: 2.5, speedLimit: 40 } },
  { name: 'Avenue', profile: { forward: 2, backward: 2, laneWidth: 3.5, sidewalk: 2.5, speedLimit: 50 } },
  { name: 'One-way', profile: { forward: 2, backward: 0, laneWidth: 3.25, sidewalk: 2, speedLimit: 40 } },
  { name: 'Boulevard', profile: { forward: 3, backward: 3, laneWidth: 3.5, sidewalk: 3, speedLimit: 60 } },
  { name: 'Lane', profile: { forward: 1, backward: 0, laneWidth: 3, sidewalk: 1.5, speedLimit: 30 } },
  { name: 'Alley', profile: { forward: 1, backward: 1, laneWidth: 2.75, sidewalk: 1, speedLimit: 30 } },
];

/** What the world must provide to the editor. Snapshots are opaque (network + demolition state). */
export interface EditorHost {
  readonly zone: Zone;
  network(): RoadNetwork;
  /** City items the candidate's roads would demolish, and what that costs (k€). */
  demolition(candidate: RoadNetwork): { items: number[]; cost: number };
  /** Makes `net` the live network, demolishing `items`, and charges `cost`. */
  commit(net: RoadNetwork, items: number[], cost: number): void;
  snapshot(): unknown;
  restore(snapshot: unknown): void;
}

export interface Marker {
  pos: Vec3;
  /** 'blocked': a road can't start here (drawn as a red cross). */
  kind: 'node' | 'segment' | 'free' | 'handle' | 'blocked';
}

/** An edit in progress (while a finger is down), shown as a preview. */
export interface Draft {
  candidate: RoadNetwork | null;
  /** Roads created or reshaped (in the candidate), and those plus their neighbours. */
  changed: number[];
  touched: number[];
  markers: Marker[];
  error: string | null;
  cost: number;
  demolish: number[];
  demolishCost: number;
}

const HISTORY_LIMIT = 100;
/** How far along a road a blocked point may move onto a plain joint (m). See `Editor.settle`. */
const JOINT_SNAP = 20;

/**
 * Touch-first road editor. DOM-free: it receives ground points (and a pick tolerance in metres
 * that matches a finger's size at that zoom) and edits a copy of the network, which the host
 * makes live on commit. Every commit can be undone.
 */
export class Editor {
  tool: Tool = 'view';
  preset = 0;
  /**
   * How the Road tool draws: 'drag' from start to end in one gesture, or 'tap' the start and then
   * the end (one-finger drags move the view in between).
   */
  roadMode: 'drag' | 'tap' = 'drag';
  selection: Pick = null;
  draft: Draft | null = null;
  hover: Marker | null = null;
  /** Last message for the player (errors after a tap, hints). */
  message: string | null = null;
  private start: Anchor | null = null;
  private bendSeg = -1;
  private readonly past: unknown[] = [];
  private readonly future: unknown[] = [];
  /** Bumped on every change, so views know when to refresh. */
  version = 0;

  constructor(private readonly host: EditorHost) {}

  private changed(): void {
    this.version++;
  }

  setTool(t: Tool): void {
    this.cancel();
    this.tool = t;
    this.selection = null;
    this.hover = null;
    this.message = null;
    this.changed();
  }

  /** Drag tools take over single-finger drags; the other tools leave them to the camera. */
  get dragTool(): boolean {
    return (this.tool === 'road' && this.roadMode === 'drag') || this.tool === 'bend';
  }

  setRoadMode(m: 'drag' | 'tap'): void {
    this.cancel();
    this.roadMode = m;
    this.hover = null;
    this.message = null;
    this.changed();
  }

  /** Tap mode: a start point is placed and the next tap ends the road. */
  get pendingStart(): boolean {
    return this.tool === 'road' && this.roadMode === 'tap' && this.start !== null;
  }

  private get net(): RoadNetwork {
    return this.host.network();
  }

  private editable = (id: number): boolean => segmentEditable(this.net, this.host.zone, this.net.segment(id));

  // ---------------------------------------------------------------- gestures

  /** Finger/mouse down with a drag tool. Returns true if the editor takes the gesture. */
  down(p: Vec3, tol: number): boolean {
    this.message = null;
    if (this.tool === 'road') {
      const snap = { anchor: this.settle(snapPoint(this.net, this.host.zone, p, tol).anchor) };
      const problem = this.startProblem(snap.anchor);
      if (problem) {
        // Nothing gets built from here: keep the red cross under the finger until it lifts.
        this.start = null;
        this.draft = {
          candidate: null, changed: [], touched: [], markers: [{ pos: snap.anchor.pos, kind: 'blocked' }],
          error: problem, cost: 0, demolish: [], demolishCost: 0,
        };
        this.changed();
        return true;
      }
      this.start = snap.anchor;
      this.draft = {
        candidate: null, changed: [], touched: [], markers: [{ pos: snap.anchor.pos, kind: snap.anchor.kind }],
        error: this.outside(snap.anchor), cost: 0, demolish: [], demolishCost: 0,
      };
      this.changed();
      return true;
    }
    if (this.tool === 'bend') {
      const pick = pickAt(this.net, p, tol, { node: () => false, segment: this.editable });
      if (pick?.kind !== 'segment' || this.net.segment(pick.id).ring !== undefined) {
        this.message = pick?.kind === 'segment'
          ? 'Roundabouts keep their round shape: change their size with the Edit tool'
          : 'Drag the middle of a road inside the zone to bend it';
        this.changed();
        return true; // still swallow the drag so the view doesn't jump
      }
      this.bendSeg = pick.id;
      this.move(p, tol);
      return true;
    }
    return false;
  }

  move(p: Vec3, tol: number): void {
    if (this.tool === 'road' && this.start) {
      const end = this.settle(snapPoint(this.net, this.host.zone, p, tol, this.start).anchor);
      const markers: Marker[] = [{ pos: this.start.pos, kind: this.start.kind }, { pos: end.pos, kind: end.kind }];
      const err = this.outside(this.start) ?? this.outside(end);
      const preset = ROAD_PRESETS[this.preset]!;
      this.draft = this.preview((net) => addRoad(net, this.start!, end, preset.profile), markers, err);
      this.changed();
    } else if (this.tool === 'bend' && this.bendSeg >= 0) {
      this.draft = this.preview((net) => bendRoad(net, this.bendSeg, p), [{ pos: [p[0], 0, p[2]], kind: 'handle' }], null);
      this.changed();
    }
  }

  up(): void {
    const d = this.draft;
    if (d?.candidate && !d.error && d.touched.length > 0) {
      this.commit(d.candidate, d.demolish, d.cost + d.demolishCost);
    } else if (d?.error && d.candidate !== null) {
      this.message = d.error;
    } else if (this.tool === 'road' && d && !d.candidate) {
      this.message = d.error ?? 'Drag from one point to another to build a road';
    }
    this.cancel();
  }

  cancel(): void {
    this.start = null;
    this.bendSeg = -1;
    this.draft = null;
    this.changed();
  }

  /** Mouse hover (desktop): show where a road would snap. */
  hoverAt(p: Vec3 | null, tol: number): void {
    if (this.pendingStart && p) {
      this.move(p, tol); // rubber-band preview from the placed start
      return;
    }
    if (this.tool !== 'road' || !p || this.start) {
      if (this.hover) {
        this.hover = null;
        this.changed();
      }
      return;
    }
    const a = this.settle(snapPoint(this.net, this.host.zone, p, tol).anchor);
    this.hover = { pos: a.pos, kind: this.startProblem(a) ? 'blocked' : a.kind };
    this.changed();
  }

  /**
   * Tap mode: the first tap places the start (refused where no road can start), the second builds
   * the road. Tapping the start again cancels; a road that can't be built keeps the start and
   * shows why, so the player can tap another end.
   */
  private tapRoad(p: Vec3, tol: number): void {
    if (!this.start) {
      const a = this.settle(snapPoint(this.net, this.host.zone, p, tol).anchor);
      const problem = this.outside(a) ?? this.startProblem(a);
      if (problem) {
        this.message = problem;
      } else {
        this.start = a;
        this.hover = null;
        this.draft = {
          candidate: null, changed: [], touched: [], markers: [{ pos: a.pos, kind: a.kind }],
          error: null, cost: 0, demolish: [], demolishCost: 0,
        };
      }
      this.changed();
      return;
    }
    const s = this.start.pos;
    if (Math.hypot(p[0] - s[0], p[2] - s[2]) < tol) {
      this.cancel();
      return;
    }
    this.move(p, tol);
    const d = this.draft;
    if (d?.candidate && !d.error && d.touched.length > 0) {
      this.commit(d.candidate, d.demolish, d.cost + d.demolishCost);
      this.cancel();
    } else {
      this.message = d?.error ?? 'Tap another point to end the road';
      this.changed();
    }
  }

  private problemNet: RoadNetwork | null = null;
  private readonly problems = new Map<string, string | null>();

  /** Why a road can't start at this anchor (cached per network: hover asks on every mouse move). */
  private startProblem(a: Anchor): string | null {
    if (a.kind !== 'segment' && a.kind !== 'node') return null;
    const net = this.net;
    if (this.problemNet !== net) {
      this.problemNet = net;
      this.problems.clear();
    }
    const key = `${a.kind}:${a.id}:${a.kind === 'segment' ? a.t.toFixed(3) : ''}:${this.preset}`;
    let r = this.problems.get(key);
    if (r === undefined) {
      if (this.problems.size > 500) this.problems.clear();
      r = anchorProblem(net, a, ROAD_PRESETS[this.preset]!.profile);
      this.problems.set(key, r);
    }
    return r;
  }

  /**
   * A point on a road too close to a plain joint for a junction to fit before it (e.g. where a
   * road is cut at the construction-zone border) moves onto the joint: the junction is built
   * there instead. Other anchors are returned as they are.
   */
  private settle(a: Anchor): Anchor {
    if (a.kind !== 'segment' || this.startProblem(a) === null) return a;
    const net = this.net, seg = net.segment(a.id);
    const s = seg.curve.length * a.t;
    let best: Anchor = a, bestD = JOINT_SNAP;
    for (const [end, d] of [[seg.a, s], [seg.b, seg.curve.length - s]] as const) {
      const n = net.node(end);
      if (d >= bestD || n.segments.length !== 2 || net.isJunction(end) || !nodeConnectable(net, this.host.zone, end)) continue;
      const cand: Anchor = { kind: 'node', id: end, pos: n.pos };
      if (this.startProblem(cand) !== null) continue;
      best = cand;
      bestD = d;
    }
    return best;
  }

  /** Tap with a tap tool: select or delete, or place a road's start / end in tap mode. */
  tap(p: Vec3, tol: number): void {
    this.message = null;
    const net = this.net;
    if (this.tool === 'road' && this.roadMode === 'tap') {
      this.tapRoad(p, tol);
    } else if (this.tool === 'select') {
      const r = roundaboutAt(net, p, tol * 0.5);
      if (r && zoneDistance(this.host.zone, r.centre[0], r.centre[2]) < 0) {
        this.selection = { kind: 'roundabout', id: r.id, pos: r.centre };
        this.changed();
        return;
      }
      const pick = pickAt(net, p, tol, {
        node: (id) => net.node(id).segments.length >= 3 && nodeConnectable(net, this.host.zone, id),
        segment: this.editable,
      });
      this.selection = pick;
      if (!pick) this.message = 'Tap a road or junction inside the zone';
    } else if (this.tool === 'delete') {
      const pick = pickAt(net, p, tol, { node: () => false, segment: this.editable });
      const ring = pick?.kind === 'segment' ? net.segment(pick.id).ring : undefined;
      if (ring !== undefined) this.apply((n) => removeRing(n, ring));
      else if (pick?.kind === 'segment') this.apply((n) => deleteRoad(n, pick.id));
      else this.message = 'Tap a road inside the zone to remove it';
    }
    this.changed();
  }

  // ---------------------------------------------------------------- edits

  private outside(a: Anchor): string | null {
    if (a.kind !== 'free') return null;
    return zoneDistance(this.host.zone, a.pos[0], a.pos[2]) > -1 ? 'You can only build inside the construction zone' : null;
  }

  /** Runs an edit on a copy of the live network and checks it. */
  private preview(op: (net: RoadNetwork) => EditResult, markers: Marker[], err: string | null): Draft {
    const candidate = this.net.clone();
    let touched: number[] = [], changed: number[] = [], cost = 0, error = err;
    try {
      const r = op(candidate);
      // Roads joining or leaving a roundabout may need its ring rebuilt around them.
      const ring = tidyRoundabouts(candidate);
      touched = ring.length > 0 ? [...new Set([...r.touched, ...touchedAround(candidate, ring)])] : r.touched;
      changed = ring.length > 0 ? [...r.changed, ...ring] : r.changed;
      cost = r.cost;
      error ??= validate(candidate, this.host.zone, touched, r.changed);
    } catch (e) {
      if (!(e instanceof EditError)) throw e;
      error = e.message;
    }
    const demo = error ? { items: [], cost: 0 } : this.host.demolition(candidate);
    return { candidate, changed, touched, markers, error, cost, demolish: demo.items, demolishCost: demo.cost };
  }

  /**
   * Applies an edit immediately (panel buttons, delete taps). Returns the error message, or null
   * on success.
   */
  apply(op: (net: RoadNetwork) => EditResult | void): string | null {
    const d = this.preview((net) => op(net) ?? { changed: [], touched: [], cost: 0 }, [], null);
    if (d.error) {
      this.message = d.error;
      this.changed();
      return d.error;
    }
    this.commit(d.candidate!, d.demolish, d.cost + d.demolishCost);
    return null;
  }

  private commit(net: RoadNetwork, items: number[], cost: number): void {
    this.past.push(this.host.snapshot());
    if (this.past.length > HISTORY_LIMIT) this.past.shift();
    this.future.length = 0;
    this.host.commit(net, items, cost);
    this.fixSelection();
    this.changed();
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  /** After the host replaced the whole world (a new city): forgets history and selection. */
  startOver(message: string): void {
    this.cancel();
    this.past.length = 0;
    this.future.length = 0;
    this.selection = null;
    this.message = message;
    this.changed();
  }

  undo(): void {
    const s = this.past.pop();
    if (s === undefined) return;
    this.cancel();
    this.future.push(this.host.snapshot());
    this.host.restore(s);
    this.fixSelection();
    this.changed();
  }

  redo(): void {
    const s = this.future.pop();
    if (s === undefined) return;
    this.cancel();
    this.past.push(this.host.snapshot());
    this.host.restore(s);
    this.fixSelection();
    this.changed();
  }

  /** Drops the selection if its road or junction no longer exists. */
  private fixSelection(): void {
    const s = this.selection;
    if (!s) return;
    const net = this.net;
    if (s.kind === 'node' && (!net.nodes.has(s.id) || net.node(s.id).segments.length < 3)) this.selection = null;
    if (s.kind === 'segment' && !net.segments.has(s.id)) this.selection = null;
    if (s.kind === 'roundabout' && !net.roundabouts.has(s.id)) this.selection = null;
  }

  /** Selects something (panels use this after turning a junction into a roundabout and back). */
  select(p: Pick): void {
    this.selection = p;
    this.changed();
  }
}

import type { Vec3 } from '../core/math';
import { type Zone, zoneDistance } from '../env/zone';
import { CubicBezier } from '../network/bezier';
import { type LaneProfile, type RoadNetwork, horizontal } from '../network/network';
import { type EditResult, EditError, addRoad, anchorProblem, bendRoad, deleteRoad, moveNode, touchedAround, upgradeRoad } from './ops';
import { type Pick, nearestOnSegment, pickAt } from './pick';
import { removeRing, roundaboutAt, tidyRoundabouts } from './roundabout';
import { nodeConnectable, segmentEditable } from './rules';
import { type DrawMode, type Shape, bendFrom, bendPoint, bendSpeed, continueShape, curveShape, endDirection, offsetCubic, parallelOffset, straightShape } from './shape';
import { type Anchor, snapFree, snapPoint } from './snap';
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
  /** Length of the new road (m), 0 when there is none. */
  length: number;
  /** Points the player can drag (the pending road's ends and bend handle). */
  grips: Vec3[];
  /** Measurements shown next to the finger while drawing, or null. */
  guide: Guide | null;
  /** Guide lines the road's end (or moved start) snapped onto, drawn dashed. */
  lines: [Vec3, Vec3][];
  /** A sweep in progress: roads (live ids) that lifting the finger will remove or upgrade. */
  swept: number[];
  sweepKind: 'remove' | 'upgrade' | null;
}

/** What the floating label next to a road in progress says, and where it is anchored. */
export interface Guide {
  /** The point the label sits above (the grip being dragged, else the road's end). */
  at: Vec3;
  /** Length of the road (m). */
  length: number;
  /** Angle (degrees) to the nearest road at the start, or null where it starts on open ground. */
  angle: number | null;
  /** Speed (km/h) cars slow to on its tightest bend, or null if the bend allows the limit. */
  slowTo: number | null;
}

/** A draft that only shows markers (no road yet). */
function markerDraft(markers: Marker[], error: string | null): Draft {
  return { candidate: null, changed: [], touched: [], markers, error, cost: 0, demolish: [], demolishCost: 0, length: 0, grips: [], guide: null, lines: [], swept: [], sweepKind: null };
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
  /** How the Road tool shapes new roads. */
  drawMode: DrawMode = 'straight';
  /** Snap free points to guide lines, angle steps and whole metres (joining roads always snaps). */
  snapping = true;
  /** Guide lines used by the last snap. */
  private lines: [Vec3, Vec3][] = [];
  /** Draw a pair of roads either side of the drawn line (a dual carriageway for one-way types). */
  parallel = false;
  selection: Pick = null;
  draft: Draft | null = null;
  hover: Marker | null = null;
  /** Last message for the player (errors after a tap, hints). */
  message: string | null = null;
  /**
   * Road tool. A road in progress has a start, then an end: with both it is *pending* (shown,
   * adjustable by dragging its grips, built by `confirm`). After building, its end starts the
   * next road (chaining).
   */
  private start: Anchor | null = null;
  private end: Anchor | null = null;
  /** Curve mode: how far (m) the road's middle bows out to the right of its chord. */
  private bend = 0;
  /** What the current drag moves: a new road's end, one of the pending road's grips, or nothing. */
  private grab: 'new' | 'start' | 'end' | 'bend' | null = null;
  /** True when this drag's start was placed before the gesture (tapping it again stops drawing). */
  private grabbedOld = false;
  /** Direction a chained start continues (the built road's direction at its end). */
  private chainDir: Vec3 | null = null;
  private bendSeg = -1;
  /** Reshape tool: the junction or road end being dragged, or -1. */
  private moveId = -1;
  /** Remove tool: roads swept by the current drag, and where the finger last was. */
  private sweeping = false;
  private sweep: number[] = [];
  private sweepAt: Vec3 | null = null;
  /** Where the sweep began: a sweep that never left it is a tap. */
  private sweepFrom: Vec3 | null = null;
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

  /** Drag tools may take single-finger drags (`down` decides); the other tools leave them to the camera. */
  get dragTool(): boolean {
    return this.tool === 'road' || this.tool === 'bend' || this.tool === 'delete';
  }

  /** Snaps a point for the Road tool, remembering the guide lines it used. */
  private snapAt(p: Vec3, tol: number, from?: Anchor): Anchor {
    const sn = snapPoint(this.net, this.host.zone, p, tol, from, this.snapping);
    this.lines = sn.guides;
    return this.settle(sn.anchor);
  }

  setParallel(on: boolean): void {
    this.parallel = on;
    this.refresh();
  }

  setSnapping(on: boolean): void {
    this.snapping = on;
    this.changed();
  }

  /** Picks the road type; a pending road changes with it. */
  setPreset(i: number): void {
    this.preset = i;
    this.message = null;
    this.refresh();
  }

  /** Changes how roads are shaped; a pending road is reshaped in place. */
  setDrawMode(m: DrawMode): void {
    if ((m === 'upgrade') !== (this.drawMode === 'upgrade')) this.cancel(); // drawing and upgrading don't mix
    this.hover = null;
    this.drawMode = m;
    this.bend = 0;
    this.message = null;
    this.refresh();
  }

  /** A start is placed and the road's end is still to come. */
  get pendingStart(): boolean {
    return this.tool === 'road' && this.start !== null && this.end === null;
  }

  /** A whole road is shown, waiting for `confirm` (✓) or `cancel` (✕). */
  get pending(): boolean {
    return this.tool === 'road' && this.start !== null && this.end !== null;
  }

  /** The pending road can be built as it is. */
  get canConfirm(): boolean {
    const d = this.draft;
    return this.pending && this.grab === null && !!d?.candidate && !d.error && d.touched.length > 0;
  }

  /** Continuous mode: the direction the road in progress leaves its start, or null (then it's straight). */
  private startDir(): Vec3 | null {
    const a = this.start;
    if (a && this.chainDir) return this.chainDir;
    if (!a || a.kind !== 'node' || !this.net.nodes.has(a.id)) return null;
    const arms = this.net.arms(a.id);
    if (arms.length !== 1) return null;
    const d = arms[0]!.dir; // points away from the node, back along the road
    return [-d[0], 0, -d[2]];
  }

  /** Continuous mode has nothing to continue from this start. */
  get noContinuation(): boolean {
    return this.drawMode === 'continuous' && this.start !== null && this.startDir() === null;
  }

  /** The shape of the road in progress, or an error message. */
  private shape(): Shape | string {
    const A = this.start!.pos, B = this.end!.pos;
    if (this.drawMode === 'curve') return curveShape(A, B, this.bend);
    if (this.drawMode === 'continuous') {
      const d = this.startDir();
      if (d) return continueShape(A, B, d);
    }
    return straightShape(A, B);
  }

  /** Rebuilds the preview of the road in progress. */
  private refresh(): void {
    const a = this.start, b = this.end;
    if (this.tool !== 'road' || !a) {
      this.changed();
      return;
    }
    if (!b) {
      this.draft = markerDraft([{ pos: a.pos, kind: a.kind }], null);
      this.draft.grips = [a.pos];
      this.changed();
      return;
    }
    const markers: Marker[] = [{ pos: a.pos, kind: a.kind }, { pos: b.pos, kind: b.kind }];
    const grips: Vec3[] = [a.pos, b.pos];
    if (this.drawMode === 'curve') {
      const h = bendPoint(a.pos, b.pos, this.bend);
      markers.push({ pos: h, kind: 'handle' });
      grips.push(h);
    }
    const shape = this.shape();
    const err = this.outside(a) ?? this.outside(b) ?? this.startProblem(a) ?? (typeof shape === 'string' ? shape : null);
    const profile = ROAD_PRESETS[this.preset]!.profile;
    const line = typeof shape === 'string' ? straightShape(a.pos, b.pos) : shape;
    const op = this.parallel
      ? (net: RoadNetwork): EditResult => this.addPair(net, a.pos, b.pos, line, profile)
      : (net: RoadNetwork): EditResult => addRoad(net, a, b, profile, line);
    this.draft = this.preview(op, markers, err);
    this.draft.grips = grips;
    this.draft.lines = this.lines;
    if (this.draft.candidate && typeof shape !== 'string') {
      let len = 0;
      for (const id of this.draft.changed) len += this.draft.candidate.segments.get(id)?.curve.length ?? 0;
      this.draft.length = len;
    }
    if (typeof shape !== 'string') {
      const curve = new CubicBezier(a.pos, shape.c1, shape.c2, b.pos);
      this.draft.guide = {
        at: this.grab === 'start' ? a.pos : this.grab === 'bend' ? grips[2] ?? b.pos : b.pos,
        length: curve.length,
        angle: this.angleAtStart(a, shape),
        slowTo: bendSpeed(curve, profile),
      };
    }
    this.changed();
  }

  /**
   * Parallel mode: two roads either side of the drawn line A → B. With a one-way type the left
   * one runs the other way (a dual carriageway). Each end joins whatever road or junction lies
   * under it, found in `net` as it is at that moment (the first road may have split a road).
   */
  private addPair(net: RoadNetwork, A: Vec3, B: Vec3, line: Shape, profile: LaneProfile): EditResult {
    const d = parallelOffset(profile);
    const oneWay = profile.forward === 0 || profile.backward === 0;
    const at = (p: Vec3): Anchor => this.exactAnchor(net, p);
    let changed: number[] = [], touched: number[] = [], cost = 0;
    for (const side of [1, -1]) {
      const [q0, q1, q2, q3] = offsetCubic(A, line.c1, line.c2, B, side * d);
      const r = side === 1 || !oneWay
        ? addRoad(net, at(q0), at(q3), profile, { c1: q1, c2: q2 })
        : addRoad(net, at(q3), at(q0), profile, { c1: q2, c2: q1 }); // left of a one-way pair: runs back
      changed = changed.concat(r.changed);
      touched = touched.concat(r.touched);
      cost += r.cost;
    }
    return { changed, touched: [...new Set(touched)], cost };
  }

  /**
   * What lies exactly at `p` in `net`: a junction or road end within 0.5 m, else a point on a road's
   * centre line within 0.5 m, else open ground. (Ordinary snapping reaches a road's full width,
   * which would pull one half of a parallel pair onto the other.)
   */
  private exactAnchor(net: RoadNetwork, p: Vec3): Anchor {
    const zone = this.host.zone;
    for (const n of net.nodes.values()) {
      if (Math.hypot(n.pos[0] - p[0], n.pos[2] - p[2]) < 0.5 && nodeConnectable(net, zone, n.id)) return { kind: 'node', id: n.id, pos: n.pos };
    }
    for (const seg of net.segments.values()) {
      if (!segmentEditable(net, zone, seg)) continue;
      const near = nearestOnSegment(net, seg.id, p[0], p[2]);
      if (near.dist < 0.5 && near.t > 0.001 && near.t < 0.999) return { kind: 'segment', id: seg.id, t: near.t, pos: near.pos };
    }
    return { kind: 'free', pos: [p[0], 0, p[2]] };
  }

  /** Angle (whole degrees) between the new road and the nearest road already at its start. */
  private angleAtStart(a: Anchor, shape: Shape): number | null {
    const net = this.net;
    let dirs: Vec3[] = [];
    if (a.kind === 'node' && net.nodes.has(a.id)) dirs = net.arms(a.id).map((x) => x.dir);
    else if (a.kind === 'segment' && net.segments.has(a.id)) {
      const d = horizontal(net.segment(a.id).curve.derivative(a.t));
      dirs = [d, [-d[0], 0, -d[2]]];
    }
    if (dirs.length === 0) return null;
    const mine = horizontal([shape.c1[0] - a.pos[0], 0, shape.c1[2] - a.pos[2]]);
    let best = Infinity;
    for (const d of dirs) best = Math.min(best, Math.acos(Math.max(-1, Math.min(1, d[0] * mine[0] + d[2] * mine[2]))));
    return Math.round((best * 180) / Math.PI);
  }

  /**
   * Builds the pending road (✓). Its end becomes the start of the next road. Returns the error
   * message if it can't be built.
   */
  confirm(): string | null {
    if (!this.pending) return null;
    const d = this.draft;
    if (!this.canConfirm || !d?.candidate) {
      this.message = d?.error ?? 'This road can\'t be built';
      this.changed();
      return this.message;
    }
    const shape = this.shape();
    const A = this.start!.pos, B = this.end!.pos;
    const dir = typeof shape === 'string' ? null : endDirection(A, B, shape);
    this.commit(d.candidate, d.demolish, d.cost + d.demolishCost);
    // Chain: carry on from the node now at the end.
    const net = this.net;
    let next: Anchor | null = null;
    for (const n of net.nodes.values()) {
      if (Math.hypot(n.pos[0] - B[0], n.pos[2] - B[2]) < 0.01 && nodeConnectable(net, this.host.zone, n.id)) next = { kind: 'node', id: n.id, pos: n.pos };
    }
    this.end = null;
    this.bend = 0;
    this.grab = null;
    // A parallel pair ends either side of the drawn line: carry on from the line's end.
    if (this.parallel && this.outside({ kind: 'free', pos: B }) === null) next = { kind: 'free', pos: B };
    if (next && this.startProblem(next) === null) {
      this.start = next;
      this.chainDir = dir;
      this.message = null;
    } else {
      this.start = null;
      this.chainDir = null;
      this.draft = null;
    }
    this.refresh();
    return null;
  }

  private get net(): RoadNetwork {
    return this.host.network();
  }

  private editable = (id: number): boolean => segmentEditable(this.net, this.host.zone, this.net.segment(id));

  /**
   * The Reshape tool may move this junction or road end: inside the zone (not on its border,
   * where roads continue outside), not on a roundabout, and all its roads editable.
   */
  movable = (id: number): boolean => {
    const net = this.net, n = net.node(id);
    if (n.ring !== undefined || n.segments.length === 0) return false;
    if (zoneDistance(this.host.zone, n.pos[0], n.pos[2]) > -1) return false;
    return n.segments.every((s) => net.segment(s).ring === undefined && this.editable(s));
  };

  // ---------------------------------------------------------------- gestures

  /** Finger/mouse down with a drag tool. Returns true if the editor takes the gesture. */
  down(p: Vec3, tol: number): boolean {
    this.message = null;
    if (this.tool === 'delete' || (this.tool === 'road' && this.drawMode === 'upgrade')) {
      // A drag that starts on a road sweeps roads (to remove or upgrade them); one that starts
      // elsewhere moves the view.
      if (this.sweepable(p, tol) === null) return false;
      this.sweeping = true;
      this.sweep = [];
      this.sweepAt = null;
      this.sweepFrom = [p[0], 0, p[2]];
      this.move(p, tol);
      return true;
    }
    if (this.tool === 'road') return this.downRoad(p, tol);
    if (this.tool === 'bend') {
      const pick = pickAt(this.net, p, tol, { node: this.movable, segment: this.editable });
      if (pick?.kind === 'node') {
        this.moveId = pick.id;
        this.move(p, tol);
        return true;
      }
      if (pick?.kind !== 'segment' || this.net.segment(pick.id).ring !== undefined) {
        this.message = pick?.kind === 'segment'
          ? 'Roundabouts keep their round shape: change their size with the Edit tool'
          : 'Drag a junction or road end to move it, or the middle of a road to bend it';
        this.changed();
        return true; // still swallow the drag so the view doesn't jump
      }
      this.bendSeg = pick.id;
      this.move(p, tol);
      return true;
    }
    return false;
  }

  /**
   * Road tool: on a pending road, grab the nearest grip (else leave the drag to the camera);
   * with only a start, a drag from it pulls out the end; with nothing yet, place the start here.
   */
  private downRoad(p: Vec3, tol: number): boolean {
    const near = (q: Vec3): number => Math.hypot(q[0] - p[0], q[2] - p[2]);
    if (this.start && this.end) {
      const grips: ['start' | 'end' | 'bend', Vec3][] = [['start', this.start.pos], ['end', this.end.pos]];
      if (this.drawMode === 'curve') grips.unshift(['bend', bendPoint(this.start.pos, this.end.pos, this.bend)]);
      let best: (typeof grips)[number] | null = null;
      for (const g of grips) if (near(g[1]) < tol * 1.2 && (!best || near(g[1]) < near(best[1]))) best = g;
      if (!best) return false;
      this.grab = best[0];
      this.grabbedOld = true;
      this.refresh();
      return true;
    }
    if (this.start) {
      if (near(this.start.pos) > tol * 1.2) return false;
      this.grab = 'new';
      this.grabbedOld = true;
      return true;
    }
    const a = this.snapAt(p, tol);
    const problem = this.outside(a) ?? this.startProblem(a);
    if (problem) {
      // Nothing gets built from here: keep the red cross under the finger until it lifts.
      this.draft = markerDraft([{ pos: a.pos, kind: 'blocked' }], problem);
      this.changed();
      return true;
    }
    this.start = a;
    this.chainDir = null;
    this.grab = 'new';
    this.grabbedOld = false;
    this.hover = null;
    this.refresh();
    return true;
  }

  move(p: Vec3, tol: number): void {
    if (this.tool === 'road' && this.start && this.grab) {
      if (this.grab === 'new' || this.grab === 'end') {
        const end = this.snapAt(p, tol, this.start);
        // Too close to the start to be a road: keep only the start.
        this.end = Math.hypot(end.pos[0] - this.start.pos[0], end.pos[2] - this.start.pos[2]) < 1 ? null : end;
      } else if (this.grab === 'start' && this.end) {
        const keep = { start: this.start.pos, end: this.end.pos };
        this.start = this.snapAt(p, tol, this.end);
        this.chainDir = null; // no longer where the previous road ended
        if (Math.hypot(keep.end[0] - this.start.pos[0], keep.end[2] - this.start.pos[2]) < 1) this.start = { kind: 'free', pos: keep.start };
      } else if (this.grab === 'bend' && this.end) {
        this.bend = bendFrom(this.start.pos, this.end.pos, [p[0], 0, p[2]]);
      }
      this.refresh();
    } else if (this.sweeping) {
      // Check points along the finger's path, so a quick swipe doesn't skip a road.
      const from = this.sweepAt ?? p;
      const n = Math.max(1, Math.ceil(Math.hypot(p[0] - from[0], p[2] - from[2]) / Math.max(0.5, tol / 2)));
      for (let k = 1; k <= n; k++) {
        const q: Vec3 = [from[0] + ((p[0] - from[0]) * k) / n, 0, from[2] + ((p[2] - from[2]) * k) / n];
        const id = this.sweepable(q, tol);
        if (id !== null && !this.sweep.includes(id)) this.sweep.push(id);
      }
      this.sweepAt = [p[0], 0, p[2]];
      this.draft = markerDraft([], null);
      this.draft.swept = this.sweep;
      this.draft.sweepKind = this.tool === 'delete' ? 'remove' : 'upgrade';
      this.changed();
    } else if (this.tool === 'bend' && this.moveId >= 0) {
      const id = this.moveId;
      const to = snapFree(this.net, p, tol, this.net.node(id).pos, this.snapping);
      this.draft = this.preview((net) => moveNode(net, id, to.pos), [{ pos: to.pos, kind: 'handle' }], null);
      this.draft.lines = to.guides;
      this.changed();
    } else if (this.tool === 'bend' && this.bendSeg >= 0) {
      this.draft = this.preview((net) => bendRoad(net, this.bendSeg, p), [{ pos: [p[0], 0, p[2]], kind: 'handle' }], null);
      this.changed();
    }
  }

  up(): void {
    if (this.sweeping) {
      const ids = this.sweep, from = this.sweepFrom, at = this.sweepAt;
      const tapped = !!from && !!at && Math.hypot(at[0] - from[0], at[2] - from[2]) < 1;
      this.cancel();
      if (this.tool === 'delete') {
        if (ids.length > 0) this.removeRoads(ids);
      } else if (tapped && ids.length === 1) {
        this.upgradeOne(ids[0]!); // a tap: may also turn a one-way road round
      } else if (ids.length > 0) {
        this.upgradeRoads(ids);
      }
      return;
    }
    if (this.tool === 'road') {
      const grab = this.grab;
      this.grab = null;
      if (!this.start) {
        // Lifted from a red cross.
        this.message = this.draft?.error ?? null;
        this.draft = null;
      } else if (grab === 'new' && !this.end && this.grabbedOld) {
        this.cancel(); // tapped the start again: stop drawing
        return;
      }
      this.refresh();
      return;
    }
    const d = this.draft;
    if (d?.candidate && !d.error && d.touched.length > 0) {
      this.commit(d.candidate, d.demolish, d.cost + d.demolishCost);
    } else if (d?.error && d.candidate !== null) {
      this.message = d.error;
    }
    this.cancel();
  }

  /** Drops the road in progress (✕, Escape, another tool) or the bend being dragged. */
  cancel(): void {
    this.lines = [];
    this.start = null;
    this.end = null;
    this.bend = 0;
    this.grab = null;
    this.chainDir = null;
    this.bendSeg = -1;
    this.moveId = -1;
    this.sweeping = false;
    this.sweep = [];
    this.sweepAt = null;
    this.sweepFrom = null;
    this.draft = null;
    this.changed();
  }

  /** ✕ / Escape: drops the road in progress and any message about it. */
  discard(): void {
    this.message = null;
    this.cancel();
  }

  /** Upgrade mode: the road under the finger takes the chosen type (or a one-way road turns round). */
  private upgradeAt(p: Vec3, tol: number): void {
    const pick = pickAt(this.net, p, tol, { node: () => false, segment: this.editable });
    if (pick?.kind !== 'segment') {
      this.message = 'Tap a road inside the zone to change it to this type';
      this.changed();
      return;
    }
    this.upgradeOne(pick.id);
  }

  private upgradeOne(id: number): void {
    this.apply((n) => upgradeRoad(n, id, ROAD_PRESETS[this.preset]!.profile));
  }

  /**
   * Swept roads take the chosen type as one undoable step. Roads that already are this type are
   * left alone (a sweep doesn't turn one-ways round), as are those that can't change; the
   * message says how many were skipped and why.
   */
  private upgradeRoads(ids: number[]): void {
    const profile = ROAD_PRESETS[this.preset]!.profile;
    let skipped = 0, reason = '';
    const err = this.apply((n) => {
      let changed: number[] = [], touched: number[] = [], cost = 0;
      for (const id of ids) {
        const seg = n.segments.get(id);
        if (!seg) continue;
        const p = seg.profile;
        const back = p.forward === 0 && p.backward > 0;
        const same = (back ? p.backward === profile.forward && p.forward === profile.backward : p.forward === profile.forward && p.backward === profile.backward)
          && p.laneWidth === profile.laneWidth && p.sidewalk === profile.sidewalk && (p.speedLimit ?? 50) === (profile.speedLimit ?? 50);
        if (same) continue;
        const before = JSON.stringify(seg.profile);
        try {
          const r = upgradeRoad(n, id, profile);
          changed = changed.concat(r.changed);
          touched = touched.concat(r.touched);
          cost += r.cost;
        } catch (e) {
          if (!(e instanceof EditError)) throw e;
          seg.profile = JSON.parse(before); // undo this road's change and skip it
          skipped++;
          reason = e.message;
        }
      }
      if (changed.length === 0) throw new EditError(reason || 'These roads already are that type');
      return { changed, touched: [...new Set(touched)], cost };
    });
    if (err === null && skipped > 0) {
      this.message = `${skipped} ${skipped === 1 ? 'road' : 'roads'} skipped: ${reason}`;
      this.changed();
    }
  }

  /** Mouse hover (desktop): show where a road would snap, or rubber-band from a placed start. */
  hoverAt(p: Vec3 | null, tol: number): void {
    if (this.tool === 'road' && this.drawMode === 'upgrade') {
      const pick = p ? pickAt(this.net, p, tol, { node: () => false, segment: this.editable }) : null;
      this.hover = pick?.kind === 'segment' ? { pos: pick.pos, kind: this.net.segment(pick.id).ring === undefined ? 'segment' : 'blocked' } : null;
      this.changed();
      return;
    }
    if (this.pendingStart && p && !this.grab) {
      this.end = this.snapAt(p, tol, this.start!);
      const s = this.start!.pos;
      if (Math.hypot(this.end.pos[0] - s[0], this.end.pos[2] - s[2]) < 1) this.end = null;
      this.refresh();
      this.end = null; // only a preview: the click places the end
      return;
    }
    if (this.tool !== 'road' || !p || this.start) {
      if (this.hover) {
        this.hover = null;
        this.changed();
      }
      return;
    }
    const a = this.snapAt(p, tol);
    this.hover = { pos: a.pos, kind: this.startProblem(a) ? 'blocked' : a.kind };
    this.changed();
  }

  /** Road tool tap away from the grips: with only a start, the tap places the end. */
  private tapRoad(p: Vec3, tol: number): void {
    if (this.drawMode === 'upgrade') {
      this.upgradeAt(p, tol);
      return;
    }
    if (!this.pendingStart) {
      if (this.pending) this.message = 'Tap ✓ to build the road, or ✕ to drop it · drag its circles to adjust it';
      this.changed();
      return;
    }
    const end = this.snapAt(p, tol, this.start!);
    const s = this.start!.pos;
    if (Math.hypot(end.pos[0] - s[0], end.pos[2] - s[2]) < 1) return;
    this.end = end;
    this.refresh();
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
    if (this.tool === 'road') {
      this.tapRoad(p, tol);
      return;
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
      const id = this.sweepable(p, tol);
      if (id !== null) this.removeRoads([id]);
      else this.message = 'Tap a road inside the zone to remove it, or drag across several';
    }
    this.changed();
  }

  // ---------------------------------------------------------------- edits

  /** The road under a point a sweep can take (editable; Upgrade also skips roundabout rings), or null. */
  private sweepable(p: Vec3, tol: number): number | null {
    const net = this.net, upgrade = this.tool === 'road';
    const pick = pickAt(net, p, tol, { node: () => false, segment: (id) => this.editable(id) && !(upgrade && net.segment(id).ring !== undefined) });
    return pick?.kind === 'segment' ? pick.id : null;
  }

  /**
   * Removes roads as one undoable step. A roundabout ring segment takes its whole ring with it;
   * roads already gone (with a ring) are skipped.
   */
  private removeRoads(ids: number[]): void {
    this.apply((n) => {
      const rings = new Set<number>();
      for (const id of ids) {
        const ring = n.segments.get(id)?.ring;
        if (ring !== undefined) rings.add(ring);
      }
      let touched: number[] = [];
      for (const r of rings) if (n.roundabouts.has(r)) touched = touched.concat(removeRing(n, r).touched);
      for (const id of ids) if (n.segments.has(id)) touched = touched.concat(deleteRoad(n, id).touched);
      return { changed: [], touched: [...new Set(touched)].filter((t) => n.segments.has(t)), cost: 0 };
    });
  }

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
    return { candidate, changed, touched, markers, error, cost, demolish: demo.items, demolishCost: demo.cost, length: 0, grips: [], guide: null, lines: [], swept: [], sweepKind: null };
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

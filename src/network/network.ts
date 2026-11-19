import { type Vec3, vec3 } from '../core/math';
import { CubicBezier } from './bezier';

/**
 * Cross-section of a road. Right-hand traffic: looking from node `a` to node `b`,
 * forward lanes are right of the centreline and backward lanes are left of it.
 */
export interface LaneProfile {
  forward: number;
  backward: number;
  laneWidth: number; // metres
  sidewalk: number; // width of each sidewalk, metres (0 = none)
}

export interface RoadNode {
  id: number;
  pos: Vec3;
  segments: number[];
}

export interface RoadSegment {
  id: number;
  a: number;
  b: number;
  curve: CubicBezier;
  profile: LaneProfile;
}

/** One road leaving a node, described in an outward-facing frame. */
export interface Arm {
  segment: RoadSegment;
  startsHere: boolean;
  /** Trimmed end of the road at the junction boundary. */
  end: Vec3;
  /** Unit horizontal direction pointing away from the node. */
  dir: Vec3;
  /** Unit horizontal vector to the right of `dir`. */
  right: Vec3;
  /** Asphalt extent left / right of the centreline, in this outward frame. */
  leftExt: number;
  rightExt: number;
  angle: number;
}

export const horizontal = (v: Vec3): Vec3 => vec3.normalize([v[0], 0, v[2]]);
export const rightOf = (d: Vec3): Vec3 => [-d[2], 0, d[0]];

export class RoadNetwork {
  readonly nodes = new Map<number, RoadNode>();
  readonly segments = new Map<number, RoadSegment>();
  private nextId = 1;

  addNode(pos: Vec3): number {
    const id = this.nextId++;
    this.nodes.set(id, { id, pos, segments: [] });
    return id;
  }

  /** Adds a road from a to b. Omit control points for a straight road. */
  addSegment(a: number, b: number, profile: LaneProfile, c1?: Vec3, c2?: Vec3): number {
    const na = this.node(a), nb = this.node(b);
    const curve = c1 && c2 ? new CubicBezier(na.pos, c1, c2, nb.pos) : CubicBezier.line(na.pos, nb.pos);
    const id = this.nextId++;
    this.segments.set(id, { id, a, b, curve, profile });
    na.segments.push(id);
    nb.segments.push(id);
    return id;
  }

  node(id: number): RoadNode {
    const n = this.nodes.get(id);
    if (!n) throw new Error(`No node ${id}`);
    return n;
  }

  /** Untrimmed horizontal direction of a segment leaving the node. */
  private leaveDir(seg: RoadSegment, nodeId: number): Vec3 {
    const d = horizontal(seg.curve.derivative(seg.a === nodeId ? 0 : 1));
    return seg.a === nodeId ? d : vec3.scale(d, -1);
  }

  /**
   * Nodes that need their own surface: 3+ roads, or 2 roads meeting at an angle
   * (a straight 2-road node is just a seamless continuation).
   */
  isJunction(nodeId: number): boolean {
    const segs = this.node(nodeId).segments;
    if (segs.length >= 3) return true;
    if (segs.length < 2) return false;
    const d0 = this.leaveDir(this.segments.get(segs[0]!)!, nodeId);
    const d1 = this.leaveDir(this.segments.get(segs[1]!)!, nodeId);
    return vec3.dot(d0, d1) > -0.985; // more than ~10° away from a straight continuation
  }

  /**
   * Distance from the node centre at which connected roads stop and the junction surface begins.
   * Simple heuristic sized for roughly perpendicular crossings; refined in the editor milestone.
   */
  junctionRadius(nodeId: number): number {
    const n = this.node(nodeId);
    if (!this.isJunction(nodeId)) return 0;
    let half = 0, walk = 0;
    for (const sid of n.segments) {
      const p = this.segments.get(sid)!.profile;
      half = Math.max(half, Math.max(p.forward, p.backward) * p.laneWidth);
      walk = Math.max(walk, p.sidewalk);
    }
    return half + walk + 3;
  }

  /** Arc-length range of the segment that is drawn as road (outside junction areas). */
  trimmedRange(seg: RoadSegment): [number, number] {
    const s0 = this.junctionRadius(seg.a);
    const s1 = seg.curve.length - this.junctionRadius(seg.b);
    return s1 > s0 ? [s0, s1] : [seg.curve.length / 2, seg.curve.length / 2];
  }

  /** Roads leaving a node, sorted by angle (atan2(z, x), increasing). */
  arms(nodeId: number): Arm[] {
    const arms: Arm[] = [];
    for (const sid of this.node(nodeId).segments) {
      const seg = this.segments.get(sid)!;
      const [s0, s1] = this.trimmedRange(seg);
      const startsHere = seg.a === nodeId;
      const t = seg.curve.tAtDistance(startsHere ? s0 : s1);
      const tan = horizontal(seg.curve.derivative(t));
      const dir = startsHere ? tan : vec3.scale(tan, -1);
      const { forward, backward, laneWidth } = seg.profile;
      arms.push({
        segment: seg,
        startsHere,
        end: seg.curve.point(t),
        dir,
        right: rightOf(dir),
        leftExt: (startsHere ? backward : forward) * laneWidth,
        rightExt: (startsHere ? forward : backward) * laneWidth,
        angle: Math.atan2(dir[2], dir[0]),
      });
    }
    return arms.sort((p, q) => p.angle - q.angle);
  }
}

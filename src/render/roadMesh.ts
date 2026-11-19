import { type Vec3, vec3 } from '../core/math';
import { type Arm, type RoadNetwork, type RoadSegment, horizontal, rightOf } from '../network/network';

/** Vertex layout: pos(3) normal(3) uv(2) lanes(3: forward, backward, width) material(1). */
export const ROAD_STRIDE = 12;
export const MAT_ROAD = 0; // asphalt with lane markings
export const MAT_SIDEWALK = 1;
export const MAT_ASPHALT = 2; // plain asphalt (junction surfaces)

const LIFT = 0.03; // keeps asphalt above the ground plane (no z-fighting)
const KERB = 0.15; // sidewalk height
const STEP = 2; // metres between cross-sections along a road

/** A point on a cross-section: lateral offset, height, normal (0 = up, ±1 = ±right) and material. */
interface Column {
  u: number;
  y: number;
  side: -1 | 0 | 1;
  mat: number;
}

interface Station {
  p: Vec3;
  right: Vec3;
  v: number;
}

export interface MeshData {
  vertices: Float32Array;
  indices: Uint32Array;
}

class Builder {
  readonly v: number[] = [];
  readonly i: number[] = [];

  vertexCount(): number {
    return this.v.length / ROAD_STRIDE;
  }

  push(p: Vec3, n: Vec3, u: number, vv: number, lanes: Vec3, mat: number): void {
    this.v.push(p[0], p[1], p[2], n[0], n[1], n[2], u, vv, lanes[0], lanes[1], lanes[2], mat);
  }

  /**
   * Sweeps a cross-section along stations. Columns come in pairs; each pair forms one strip.
   * Columns are ordered left → right so triangles face outward.
   */
  ribbon(stations: Station[], cols: Column[], lanes: Vec3): void {
    const base = this.vertexCount();
    for (const st of stations) {
      for (const c of cols) {
        const p = vec3.add(st.p, vec3.add(vec3.scale(st.right, c.u), [0, c.y + LIFT, 0]));
        const n: Vec3 = c.side === 0 ? [0, 1, 0] : vec3.scale(st.right, c.side);
        this.push(p, n, c.u, st.v, lanes, c.mat);
      }
    }
    const C = cols.length;
    for (let s = 0; s + 1 < stations.length; s++) {
      for (let c = 0; c + 1 < C; c += 2) {
        const a = base + s * C + c, b = a + 1, d = a + C, e = d + 1;
        this.i.push(a, b, d, b, e, d);
      }
    }
  }

  build(): MeshData {
    return { vertices: new Float32Array(this.v), indices: new Uint32Array(this.i) };
  }
}

/** Full road cross-section: outer face, sidewalk, kerb, asphalt, kerb, sidewalk, outer face. */
function roadColumns(L: number, R: number, S: number): Column[] {
  const cols: Column[] = [];
  const sw = MAT_SIDEWALK;
  if (S > 0) {
    cols.push({ u: -L - S, y: 0, side: -1, mat: sw }, { u: -L - S, y: KERB, side: -1, mat: sw });
    cols.push({ u: -L - S, y: KERB, side: 0, mat: sw }, { u: -L, y: KERB, side: 0, mat: sw });
    cols.push({ u: -L, y: KERB, side: 1, mat: sw }, { u: -L, y: 0, side: 1, mat: sw });
  }
  cols.push({ u: -L, y: 0, side: 0, mat: MAT_ROAD }, { u: R, y: 0, side: 0, mat: MAT_ROAD });
  if (S > 0) {
    cols.push({ u: R, y: 0, side: -1, mat: sw }, { u: R, y: KERB, side: -1, mat: sw });
    cols.push({ u: R, y: KERB, side: 0, mat: sw }, { u: R + S, y: KERB, side: 0, mat: sw });
    cols.push({ u: R + S, y: KERB, side: 1, mat: sw }, { u: R + S, y: 0, side: 1, mat: sw });
  }
  return cols;
}

/** Left half of a sidewalk only (used for rounded junction corners; kerb at u = 0). */
function cornerColumns(S: number): Column[] {
  const sw = MAT_SIDEWALK;
  return [
    { u: -S, y: 0, side: -1, mat: sw }, { u: -S, y: KERB, side: -1, mat: sw },
    { u: -S, y: KERB, side: 0, mat: sw }, { u: 0, y: KERB, side: 0, mat: sw },
    { u: 0, y: KERB, side: 1, mat: sw }, { u: 0, y: 0, side: 1, mat: sw },
  ];
}

function addSegment(b: Builder, net: RoadNetwork, seg: RoadSegment): void {
  const [s0, s1] = net.trimmedRange(seg);
  if (s1 - s0 < 0.01) return;
  const n = Math.max(1, Math.ceil((s1 - s0) / STEP));
  const stations: Station[] = [];
  for (let k = 0; k <= n; k++) {
    const s = s0 + ((s1 - s0) * k) / n;
    const t = seg.curve.tAtDistance(s);
    stations.push({ p: seg.curve.point(t), right: rightOf(horizontal(seg.curve.derivative(t))), v: s });
  }
  const { forward: F, backward: B, laneWidth: w, sidewalk: S } = seg.profile;
  b.ribbon(stations, roadColumns(B * w, F * w, S), [F, B, w]);
}

/** Intersection of lines p + s*dp and q + t*dq on the XZ plane; returns [s, t] or null if parallel. */
function intersectXZ(p: Vec3, dp: Vec3, q: Vec3, dq: Vec3): [number, number] | null {
  const den = dp[0] * dq[2] - dp[2] * dq[0];
  if (Math.abs(den) < 0.05) return null;
  const rx = q[0] - p[0], rz = q[2] - p[2];
  return [(rx * dq[2] - rz * dq[0]) / den, (rx * dp[2] - rz * dp[0]) / den];
}

/** Rounded kerb line from the right edge of arm `a` to the left edge of the next arm `c`. */
function cornerCurve(a: Arm, c: Arm, centre: Vec3, samples = 8): Vec3[] {
  const P = vec3.add(a.end, vec3.scale(a.right, a.rightExt));
  const Q = vec3.sub(c.end, vec3.scale(c.right, c.leftExt));

  let gap = c.angle - a.angle;
  if (gap <= 0) gap += Math.PI * 2;
  if (gap > Math.PI - 0.05) {
    // Wide (reflex) gap: sweep an arc around the node so the surface stays convex around the centre.
    const ang = (p: Vec3): number => Math.atan2(p[2] - centre[2], p[0] - centre[0]);
    const r0 = Math.hypot(P[0] - centre[0], P[2] - centre[2]);
    const r1 = Math.hypot(Q[0] - centre[0], Q[2] - centre[2]);
    const a0 = ang(P);
    let a1 = ang(Q);
    while (a1 <= a0) a1 += Math.PI * 2;
    const n = samples * 2;
    const pts: Vec3[] = [];
    for (let k = 0; k <= n; k++) {
      const t = k / n, th = a0 + (a1 - a0) * t, r = r0 + (r1 - r0) * t;
      pts.push([centre[0] + Math.cos(th) * r, P[1] + (Q[1] - P[1]) * t, centre[2] + Math.sin(th) * r]);
    }
    return pts;
  }

  const hit = intersectXZ(P, a.dir, Q, c.dir);
  const ctrl: Vec3 = hit && hit[0] < 0 && hit[1] < 0
    ? vec3.add(P, vec3.scale(a.dir, hit[0]))
    : vec3.scale(vec3.add(P, Q), 0.5);
  const pts: Vec3[] = [];
  for (let k = 0; k <= samples; k++) {
    const t = k / samples, u = 1 - t;
    pts.push(vec3.add(vec3.add(vec3.scale(P, u * u), vec3.scale(ctrl, 2 * u * t)), vec3.scale(Q, t * t)));
  }
  return pts;
}

function addJunction(b: Builder, net: RoadNetwork, nodeId: number): void {
  const arms = net.arms(nodeId);
  const centre = net.node(nodeId).pos;
  const up: Vec3 = [0, 1, 0];
  const none: Vec3 = [0, 0, 0];

  // Asphalt: polygon around the node in increasing-angle order, triangulated as a fan.
  const ring: Vec3[] = [];
  arms.forEach((a, i) => {
    const next = arms[(i + 1) % arms.length]!;
    ring.push(vec3.sub(a.end, vec3.scale(a.right, a.leftExt)));
    ring.push(...cornerCurve(a, next, centre));
  });
  const c0 = b.vertexCount();
  b.push(vec3.add(centre, [0, LIFT, 0]), up, 0, 0, none, MAT_ASPHALT);
  for (const p of ring) b.push(vec3.add(p, [0, LIFT, 0]), up, 0, 0, none, MAT_ASPHALT);
  for (let k = 0; k < ring.length; k++) {
    b.i.push(c0, c0 + 1 + ((k + 1) % ring.length), c0 + 1 + k);
  }

  // Sidewalk corners: swept along the kerb curve; the sidewalk lies on the far side from the node.
  arms.forEach((a, i) => {
    const next = arms[(i + 1) % arms.length]!;
    const S = Math.min(a.segment.profile.sidewalk, next.segment.profile.sidewalk);
    if (S <= 0) return;
    const pts = cornerCurve(a, next, centre);
    const stations: Station[] = pts.map((p, k) => {
      const prev = pts[Math.max(0, k - 1)]!, nxt = pts[Math.min(pts.length - 1, k + 1)]!;
      return { p, right: rightOf(horizontal(vec3.sub(nxt, prev))), v: k };
    });
    b.ribbon(stations, cornerColumns(S), none);
  });
}

export function buildRoadMesh(net: RoadNetwork): MeshData {
  const b = new Builder();
  for (const seg of net.segments.values()) addSegment(b, net, seg);
  for (const id of net.nodes.keys()) if (net.isJunction(id)) addJunction(b, net, id);
  return b.build();
}

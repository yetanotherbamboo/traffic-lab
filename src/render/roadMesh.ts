import { type Vec3, vec3 } from '../core/math';
import { type Arm, NEAR_STRAIGHT_COS, type RoadNetwork, type RoadSegment, horizontal, rightOf } from '../network/network';

/** Vertex layout: pos(3) normal(3) uv(2) lanes(3: forward, backward, width) material(1). */
export const ROAD_STRIDE = 12;
export const MAT_ROAD = 0; // asphalt with lane markings
export const MAT_SIDEWALK = 1;
export const MAT_ASPHALT = 2; // plain asphalt (junction surfaces)
export const MAT_PAINT = 3; // road paint shapes (lane arrows, lines through junctions)
export const MAT_PAINT_YELLOW = 4; // yellow road paint (centre lines through junctions)

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
  const n = seg.curve.pieces(s0, s1, STEP);
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

/**
 * Rounded kerb line from the right edge of arm `a` to the left edge of the next arm `c`. Sets
 * `cornerRadius` to the fillet radius (Infinity for straight or wide corners): a corner sidewalk
 * wider than that would fold over itself.
 */
let cornerRadius = Infinity;
/** Centre and radius of the last fillet built by `cornerCurve` (null when the corner isn't a fillet). */
let cornerCentre: Vec3 | null = null;
let cornerFillet = Infinity;
/** Outside corners (e.g. the outside of a bend): kerb radius (m), and how far out the kerbs may meet (× the road ends' distance). */
const OUTER_KERB_R = 4;
const MITRE_REACH = 2.5;
function cornerCurve(a: Arm, c: Arm, centre: Vec3, samples = 8): Vec3[] {
  cornerRadius = Infinity;
  cornerCentre = null;
  cornerFillet = Infinity;
  const P = vec3.add(a.end, vec3.scale(a.right, a.rightExt));
  const Q = vec3.sub(c.end, vec3.scale(c.right, c.leftExt));

  let gap = c.angle - a.angle;
  if (gap <= 0) gap += Math.PI * 2;
  if (vec3.dot(a.dir, c.dir) < -0.985) {
    // Opposite arms (straight through side of a T, or a lane-count change): a straight kerb.
    const pts: Vec3[] = [];
    for (let k = 0; k <= samples; k++) pts.push(vec3.add(P, vec3.scale(vec3.sub(Q, P), k / samples)));
    return pts;
  }
  if (gap > Math.PI - 0.05) {
    // Wide (reflex) gap, e.g. the outside of a bend: carry both outer kerbs on until they meet and
    // round that corner a little, like a street corner. (Sweeping an arc around the node made a
    // big round blob there.) Only where the kerbs meet behind both road ends and not too far out.
    const hit = intersectXZ(P, a.dir, Q, c.dir);
    if (hit && hit[0] < 0 && hit[1] < 0) {
      const X = vec3.add(P, vec3.scale(a.dir, hit[0]));
      const reach = Math.max(Math.hypot(P[0] - centre[0], P[2] - centre[2]), Math.hypot(Q[0] - centre[0], Q[2] - centre[2]));
      if (Math.hypot(X[0] - centre[0], X[2] - centre[2]) < MITRE_REACH * reach) {
        const pts = fillet(P, Q, a, c, hit, samples, OUTER_KERB_R);
        if (goesRound(pts, centre)) return pts;
        cornerRadius = Infinity;
        cornerCentre = null;
        cornerFillet = Infinity;
      }
    }
    // Nearly straight on (within 30°), the outer kerbs are almost parallel and meet far out or
    // not at all: run a straight taper from one road's edge to the other's, like a lane-count change.
    if (vec3.dot(a.dir, c.dir) < -NEAR_STRAIGHT_COS) {
      const pts: Vec3[] = [];
      for (let k = 0; k <= samples; k++) pts.push(vec3.add(P, vec3.scale(vec3.sub(Q, P), k / samples)));
      if (goesRound(pts, centre)) return pts;
    }
    // Otherwise sweep an arc around the node so the surface stays convex around the centre.
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
  if (!hit || hit[0] >= 0 || hit[1] >= 0) {
    const pts: Vec3[] = [];
    for (let k = 0; k <= samples; k++) pts.push(vec3.add(P, vec3.scale(vec3.sub(Q, P), k / samples)));
    return pts;
  }
  return fillet(P, Q, a, c, hit, samples, Infinity);
}

/**
 * The junction surface is a fan from the node, so an outer kerb must go round it (angles
 * increasing) and keep 1 m clear of it. A one-way road's outer edge is its own centre line, through
 * the node, so kerbs ending there can't: those corners keep the arc around the node.
 */
function goesRound(pts: Vec3[], centre: Vec3): boolean {
  for (let k = 0; k < pts.length; k++) {
    const p = pts[k]!, q = pts[k + 1];
    if (Math.hypot(p[0] - centre[0], p[2] - centre[2]) < 1) return false;
    if (q && (p[0] - centre[0]) * (q[2] - centre[2]) - (p[2] - centre[2]) * (q[0] - centre[0]) <= 0) return false;
  }
  return true;
}

/**
 * Circular fillet between the kerb line through P (along a.dir) and the one through Q (along
 * c.dir), which meet at P + a.dir·hit[0] = Q + c.dir·hit[1] (both behind the road ends). With
 * `maxR` finite (an outside corner) the radius is at most that and the kerb runs straight up to
 * the fillet; with Infinity (an inside corner) the fillet is as large as the shorter side allows.
 * Sets `cornerCentre`, and `cornerRadius` for inside corners only: a sidewalk outside a fillet
 * can't fold, so it needn't narrow.
 */
function fillet(P: Vec3, Q: Vec3, a: Arm, c: Arm, hit: [number, number], samples: number, maxR: number): Vec3[] {
  // Circular fillet tangent to both kerb lines (a quadratic curve would bend tighter than the
  // sidewalk is wide at sharp corners, folding the corner sidewalk over itself).
  const X = vec3.add(P, vec3.scale(a.dir, hit[0]));
  const La = -hit[0], Lc = -hit[1];
  const half = Math.acos(Math.max(-1, Math.min(1, vec3.dot(a.dir, c.dir)))) / 2; // half the angle at X
  const L = Math.min(La, Lc, Number.isFinite(maxR) ? maxR / Math.tan(half) : Infinity);
  const T1 = vec3.add(X, vec3.scale(a.dir, L));
  const T2 = vec3.add(X, vec3.scale(c.dir, L));
  const bis = horizontal(vec3.add(a.dir, c.dir));
  const C = vec3.add(X, vec3.scale(bis, L / Math.cos(half)));
  const a1 = Math.atan2(T1[2] - C[2], T1[0] - C[0]);
  let a2 = Math.atan2(T2[2] - C[2], T2[0] - C[0]);
  if (a2 - a1 > Math.PI) a2 -= Math.PI * 2;
  if (a1 - a2 > Math.PI) a2 += Math.PI * 2;
  const r = Math.hypot(T1[0] - C[0], T1[2] - C[2]);
  cornerRadius = Number.isFinite(maxR) ? Infinity : r;
  cornerFillet = r;
  cornerCentre = C;
  const pts: Vec3[] = [];
  if (La > L + 0.01) pts.push(P);
  for (let k = 0; k <= samples; k++) {
    const th = a1 + ((a2 - a1) * k) / samples;
    pts.push([C[0] + Math.cos(th) * r, P[1], C[2] + Math.sin(th) * r]);
  }
  if (Lc > L + 0.01) pts.push(Q);
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
  // Fan from the node, except on a roundabout ring: there the node lies on the island edge, so
  // fan from the middle of the surface instead.
  let hub = centre;
  if (net.node(nodeId).ring !== undefined) {
    let x = 0, z = 0;
    for (const p of ring) { x += p[0]; z += p[2]; }
    hub = [x / ring.length, centre[1], z / ring.length];
  }
  const c0 = b.vertexCount();
  b.push(vec3.add(hub, [0, LIFT, 0]), up, 0, 0, none, MAT_ASPHALT);
  for (const p of ring) b.push(vec3.add(p, [0, LIFT, 0]), up, 0, 0, none, MAT_ASPHALT);
  for (let k = 0; k < ring.length; k++) {
    // Skip slivers with no area (ring points in line with the hub, e.g. along a one-way road's
    // centre line, which runs through the node): their facing is only rounding noise.
    const p = ring[k]!, q = ring[(k + 1) % ring.length]!;
    if (Math.abs((p[0] - hub[0]) * (q[2] - hub[2]) - (p[2] - hub[2]) * (q[0] - hub[0])) < 1e-3) continue;
    b.i.push(c0, c0 + 1 + ((k + 1) % ring.length), c0 + 1 + k);
  }

  // Sidewalk corners: swept along the kerb curve; the sidewalk lies on the far side from the node.
  arms.forEach((a, i) => {
    const next = arms[(i + 1) % arms.length]!;
    // Near-duplicate points (where the kerb line meets the fillet) would give a strip with a
    // reversed direction, flipping the sidewalk there. Keep the fillet's own points: at the start
    // the fillet point replaces the road-end point, so the strip leaves along the fillet tangent.
    const pts = cornerCurve(a, next, centre).filter((p, k, all) => k === 0 || Math.hypot(p[0] - all[k - 1]![0], p[2] - all[k - 1]![2]) > 0.1);
    if (pts.length < 2) return;
    // Tight corners get a narrower sidewalk so it can't fold over itself.
    const S = Math.min(a.segment.profile.sidewalk, next.segment.profile.sidewalk, cornerRadius * 0.9);
    if (S <= 0.05) return;
    // The sidewalk lies on the inside of the fillet, so station directions must be exact: on the
    // fillet the tangent of its circle, on the short straight kerb pieces either side the kerb
    // line. (Averaged neighbour directions fold the sidewalk where a short straight meets the arc.)
    const C = cornerCentre;
    const stations: Station[] = pts.map((p, k) => {
      const prev = pts[Math.max(0, k - 1)]!, nxt = pts[Math.min(pts.length - 1, k + 1)]!;
      const chord = vec3.sub(nxt, prev);
      let d = chord;
      if (C && Math.abs(Math.hypot(p[0] - C[0], p[2] - C[2]) - cornerFillet) < 1e-3) {
        const t: Vec3 = [-(p[2] - C[2]), 0, p[0] - C[0]];
        d = vec3.dot(t, chord) >= 0 ? t : vec3.scale(t, -1);
      } else if (k === 0) d = vec3.sub(nxt, p);
      else if (k === pts.length - 1) d = vec3.sub(p, prev);
      return { p, right: rightOf(horizontal(d)), v: k };
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

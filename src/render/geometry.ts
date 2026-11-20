export interface Geometry {
  /** Interleaved: position (3) + normal (3). */
  vertices: Float32Array;
  indices: Uint16Array;
}

/** Unit box: x,z in [-0.5, 0.5], y in [0, 1] (sits on the ground, handy for buildings). */
export function boxGeometry(): Geometry {
  // [normal, u-axis, v-axis] per face
  const faces: [number[], number[], number[]][] = [
    [[1, 0, 0], [0, 0, -1], [0, 1, 0]],
    [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[0, 1, 0], [1, 0, 0], [0, 0, -1]],
    [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]],
    [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
  ];
  const v: number[] = [];
  const idx: number[] = [];
  faces.forEach(([n, u, w], f) => {
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
      const x = n[0]! * 0.5 + u[0]! * a * 0.5 + w[0]! * b * 0.5;
      const y = n[1]! * 0.5 + u[1]! * a * 0.5 + w[1]! * b * 0.5 + 0.5;
      const z = n[2]! * 0.5 + u[2]! * a * 0.5 + w[2]! * b * 0.5;
      v.push(x, y, z, n[0]!, n[1]!, n[2]!);
    }
    const o = f * 4;
    idx.push(o, o + 1, o + 2, o, o + 2, o + 3);
  });
  return { vertices: new Float32Array(v), indices: new Uint16Array(idx) };
}

type V3 = [number, number, number];

/**
 * Flat-shaded mesh from a triangle list of a convex shape. Each triangle is wound so its
 * normal points away from `centre`, so the input order doesn't matter.
 */
function flatConvex(tris: [V3, V3, V3][], centre: V3): Geometry {
  const v: number[] = [];
  for (const [a, b0, c0] of tris) {
    let b = b0, c = c0;
    const e1: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const e2: V3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let n: V3 = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const mid: V3 = [(a[0] + b[0] + c[0]) / 3 - centre[0], (a[1] + b[1] + c[1]) / 3 - centre[1], (a[2] + b[2] + c[2]) / 3 - centre[2]];
    if (n[0] * mid[0] + n[1] * mid[1] + n[2] * mid[2] < 0) {
      [b, c] = [c, b];
      n = [-n[0], -n[1], -n[2]];
    }
    const l = Math.hypot(n[0], n[1], n[2]) || 1;
    for (const p of [a, b, c]) v.push(p[0], p[1], p[2], n[0] / l, n[1] / l, n[2] / l);
  }
  const count = v.length / 6;
  return { vertices: new Float32Array(v), indices: Uint16Array.from({ length: count }, (_, i) => i) };
}

/** Gable roof: footprint x,z in [-0.5, 0.5], ridge along x at y = 1. */
export function roofGeometry(): Geometry {
  const a: V3 = [-0.5, 0, -0.5], b: V3 = [0.5, 0, -0.5], c: V3 = [0.5, 0, 0.5], d: V3 = [-0.5, 0, 0.5];
  const r0: V3 = [-0.5, 1, 0], r1: V3 = [0.5, 1, 0];
  return flatConvex([
    [a, b, r1], [a, r1, r0], // north slope
    [d, c, r1], [d, r1, r0], // south slope
    [a, d, r0], [b, c, r1], // gables
  ], [0, 0.3, 0]);
}

/** Low-poly round tree crown (icosahedron), spanning y in [0, 2], radius 1. */
export function crownGeometry(): Geometry {
  const t = (1 + Math.sqrt(5)) / 2;
  const raw: V3[] = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t],
    [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ];
  const p = raw.map(([x, y, z]): V3 => {
    const l = Math.hypot(x, y, z);
    return [x / l, y / l + 1, z / l];
  });
  const faces = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  return flatConvex(faces.map(([i, j, k]) => [p[i!]!, p[j!]!, p[k!]!]), [0, 1, 0]);
}

/** Conifer: 7-sided cone, base radius 1 at y = 0, apex at y = 1 (no bottom). */
export function coneGeometry(sides = 7): Geometry {
  const tris: [V3, V3, V3][] = [];
  for (let i = 0; i < sides; i++) {
    const a0 = (i / sides) * Math.PI * 2, a1 = ((i + 1) / sides) * Math.PI * 2;
    tris.push([[Math.cos(a0), 0, Math.sin(a0)], [Math.cos(a1), 0, Math.sin(a1)], [0, 1, 0]]);
  }
  return flatConvex(tris, [0, 0.3, 0]);
}

function boxTris(min: V3, max: V3): [V3, V3, V3][] {
  const [x0, y0, z0] = min, [x1, y1, z1] = max;
  const c = (x: number, y: number, z: number): V3 => [x, y, z];
  const quad = (a: V3, b: V3, cc: V3, d: V3): [V3, V3, V3][] => [[a, b, cc], [a, cc, d]];
  return [
    ...quad(c(x0, y0, z0), c(x1, y0, z0), c(x1, y1, z0), c(x0, y1, z0)),
    ...quad(c(x0, y0, z1), c(x1, y0, z1), c(x1, y1, z1), c(x0, y1, z1)),
    ...quad(c(x0, y0, z0), c(x0, y0, z1), c(x0, y1, z1), c(x0, y1, z0)),
    ...quad(c(x1, y0, z0), c(x1, y0, z1), c(x1, y1, z1), c(x1, y1, z0)),
    ...quad(c(x0, y1, z0), c(x1, y1, z0), c(x1, y1, z1), c(x0, y1, z1)),
  ];
}

function merge(parts: Geometry[]): Geometry {
  const vertices = new Float32Array(parts.reduce((n, g) => n + g.vertices.length, 0));
  let o = 0;
  for (const g of parts) {
    vertices.set(g.vertices, o);
    o += g.vertices.length;
  }
  return { vertices, indices: Uint16Array.from({ length: vertices.length / 6 }, (_, i) => i) };
}

/**
 * Low-poly car, unit size: length along x (front = +x), width along z, height along y.
 * Body below y = 0.5, cabin above (the shader tints cabin sides as glass). No bottom faces.
 */
export function carGeometry(): Geometry {
  const box = (min: V3, max: V3): Geometry =>
    flatConvex(boxTris(min, max), [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2]);
  return merge([
    box([-0.5, 0.1, -0.5], [0.5, 0.5, 0.5]),
    box([-0.33, 0.5, -0.43], [0.2, 0.92, 0.43]),
  ]);
}

/**
 * Low-poly van, unit size like `carGeometry`: a full-length box body with a short bonnet ledge
 * at the front and a tall cargo box behind a raked windscreen. The shader glazes only the cab.
 */
export function vanGeometry(): Geometry {
  const body = flatConvex(boxTris([-0.5, 0.1, -0.5], [0.5, 0.46, 0.5]), [0, 0.28, 0]);
  // Upper box: side profile (-0.5, 0.46) (0.38, 0.46) (0.22, 0.97) (-0.5, 0.97), slightly narrower.
  const y0 = 0.46, y1 = 0.97, w = 0.48;
  const c = (x: number, y: number, z: number): V3 => [x, y, z];
  const bl = (z: number): V3[] => [c(-0.5, y0, z), c(0.38, y0, z), c(0.22, y1, z), c(-0.5, y1, z)];
  const [l, r] = [bl(-w), bl(w)];
  const quad = (a: V3, b: V3, cc: V3, d: V3): [V3, V3, V3][] => [[a, b, cc], [a, cc, d]];
  const tris: [V3, V3, V3][] = [
    ...quad(l[0]!, l[1]!, l[2]!, l[3]!), // left side
    ...quad(r[0]!, r[1]!, r[2]!, r[3]!), // right side
    ...quad(l[1]!, r[1]!, r[2]!, l[2]!), // windscreen
    ...quad(l[2]!, r[2]!, r[3]!, l[3]!), // roof
    ...quad(l[3]!, r[3]!, r[0]!, l[0]!), // rear doors
  ];
  return merge([body, flatConvex(tris, [-0.1, (y0 + y1) / 2, 0])]);
}

/** Flat square on y=0 centred at origin, position only. */
export function planeGeometry(size: number): { vertices: Float32Array; indices: Uint16Array } {
  const h = size / 2;
  return {
    vertices: new Float32Array([-h, 0, -h, h, 0, -h, h, 0, h, -h, 0, h]),
    indices: new Uint16Array([0, 2, 1, 0, 3, 2]),
  };
}

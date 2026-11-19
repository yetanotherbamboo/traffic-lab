// Minimal linear-algebra helpers. Matrices are column-major Float32Array(16), matching WebGL.

export type Vec3 = [number, number, number];
export type Mat4 = Float32Array;

export const vec3 = {
  add: (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  scale: (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a: Vec3, b: Vec3): Vec3 => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ],
  length: (a: Vec3): number => Math.hypot(a[0], a[1], a[2]),
  normalize: (a: Vec3): Vec3 => {
    const l = Math.hypot(a[0], a[1], a[2]);
    return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
  },
};

export function mat4Identity(out: Mat4 = new Float32Array(16)): Mat4 {
  out.fill(0);
  out[0] = out[5] = out[10] = out[15] = 1;
  return out;
}

export function mat4Perspective(out: Mat4, fovy: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovy / 2);
  const nf = 1 / (near - far);
  out.fill(0);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = (far + near) * nf;
  out[11] = -1;
  out[14] = 2 * far * near * nf;
  return out;
}

export function mat4LookAt(out: Mat4, eye: Vec3, target: Vec3, up: Vec3): Mat4 {
  const z = vec3.normalize(vec3.sub(eye, target));
  const x = vec3.normalize(vec3.cross(up, z));
  const y = vec3.cross(z, x);
  out[0] = x[0]; out[1] = y[0]; out[2] = z[0]; out[3] = 0;
  out[4] = x[1]; out[5] = y[1]; out[6] = z[1]; out[7] = 0;
  out[8] = x[2]; out[9] = y[2]; out[10] = z[2]; out[11] = 0;
  out[12] = -vec3.dot(x, eye);
  out[13] = -vec3.dot(y, eye);
  out[14] = -vec3.dot(z, eye);
  out[15] = 1;
  return out;
}

/** out = a * b. `out` may alias `a` or `b`. */
export function mat4Multiply(out: Mat4, a: Mat4, b: Mat4): Mat4 {
  const r = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let row = 0; row < 4; row++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + row]! * b[c * 4 + k]!;
      r[c * 4 + row] = s;
    }
  }
  out.set(r);
  return out;
}

export function mat4Invert(out: Mat4, m: Mat4): Mat4 | null {
  const a00 = m[0]!, a01 = m[1]!, a02 = m[2]!, a03 = m[3]!;
  const a10 = m[4]!, a11 = m[5]!, a12 = m[6]!, a13 = m[7]!;
  const a20 = m[8]!, a21 = m[9]!, a22 = m[10]!, a23 = m[11]!;
  const a30 = m[12]!, a31 = m[13]!, a32 = m[14]!, a33 = m[15]!;
  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (Math.abs(det) < 1e-12) return null;
  det = 1 / det;
  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
  out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
  out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
  out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
  out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
  out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
  out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
  out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
  return out;
}

/** Transforms a point by m and performs the perspective divide. */
export function mat4TransformPoint(m: Mat4, p: Vec3): Vec3 {
  const x = p[0], y = p[1], z = p[2];
  const w = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!;
  return [
    (m[0]! * x + m[4]! * y + m[8]! * z + m[12]!) / w,
    (m[1]! * x + m[5]! * y + m[9]! * z + m[13]!) / w,
    (m[2]! * x + m[6]! * y + m[10]! * z + m[14]!) / w,
  ];
}

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

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

/** Flat square on y=0 centred at origin, position only. */
export function planeGeometry(size: number): { vertices: Float32Array; indices: Uint16Array } {
  const h = size / 2;
  return {
    vertices: new Float32Array([-h, 0, -h, h, 0, -h, h, 0, h, -h, 0, h]),
    indices: new Uint16Array([0, 2, 1, 0, 3, 2]),
  };
}

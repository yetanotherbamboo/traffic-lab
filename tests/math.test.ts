import { describe, expect, it } from 'vitest';
import {
  mat4Identity, mat4Invert, mat4LookAt, mat4Multiply, mat4Perspective, mat4TransformPoint,
} from '../src/core/math';
import { OrbitCamera } from '../src/render/camera';

const close = (a: ArrayLike<number>, b: ArrayLike<number>, eps = 1e-4): void => {
  for (let i = 0; i < a.length; i++) expect(a[i]).toBeCloseTo(b[i]!, -Math.log10(eps));
};

describe('mat4', () => {
  it('invert(m) * m = identity', () => {
    const m = mat4Perspective(new Float32Array(16), 0.8, 1.5, 1, 100);
    const v = mat4LookAt(new Float32Array(16), [10, 20, 30], [0, 0, 0], [0, 1, 0]);
    mat4Multiply(m, m, v);
    const inv = mat4Invert(new Float32Array(16), m)!;
    close(mat4Multiply(new Float32Array(16), inv, m), mat4Identity());
  });

  it('lookAt maps the eye to the origin and the target onto -Z', () => {
    const v = mat4LookAt(new Float32Array(16), [5, 5, 5], [0, 0, 0], [0, 1, 0]);
    close(mat4TransformPoint(v, [5, 5, 5]), [0, 0, 0]);
    const t = mat4TransformPoint(v, [0, 0, 0]);
    close(t, [0, 0, -Math.sqrt(75)]);
  });
});

describe('OrbitCamera', () => {
  it('screen centre ray hits the target on the ground', () => {
    const cam = new OrbitCamera();
    cam.target = [12, 0, -7];
    cam.update(16 / 9);
    close(cam.groundHit(0, 0)!, [12, 0, -7], 1e-2);
  });

  it('clamps pitch and distance', () => {
    const cam = new OrbitCamera();
    cam.pitch = 10;
    cam.distance = 1;
    cam.update(1);
    expect(cam.pitch).toBe(cam.maxPitch);
    expect(cam.distance).toBe(cam.minDistance);
  });
});

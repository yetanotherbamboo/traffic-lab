import {
  type Mat4, type Vec3, clamp, mat4Identity, mat4Invert, mat4LookAt, mat4Multiply,
  mat4Perspective, mat4TransformPoint, vec3,
} from '../core/math';

export interface Ray {
  origin: Vec3;
  dir: Vec3;
}

/**
 * City-builder style orbit camera: looks at `target` on the ground from
 * `distance`, rotated by `yaw` around the vertical axis and tilted by `pitch`
 * (radians above the horizon). World is Y-up, in metres.
 */
export class OrbitCamera {
  target: Vec3 = [0, 0, 0];
  yaw = 0.7;
  pitch = 0.85;
  distance = 140;
  fovy = (45 * Math.PI) / 180;
  aspect = 1;

  minPitch = 0.3;
  maxPitch = 1.45;
  minDistance = 15;
  maxDistance = 700;
  bounds = 1000; // target is kept within ±bounds on x/z

  readonly view: Mat4 = mat4Identity();
  readonly proj: Mat4 = mat4Identity();
  readonly viewProj: Mat4 = mat4Identity();
  readonly invViewProj: Mat4 = mat4Identity();
  eye: Vec3 = [0, 0, 0];

  update(aspect = this.aspect): void {
    this.aspect = aspect;
    this.pitch = clamp(this.pitch, this.minPitch, this.maxPitch);
    this.distance = clamp(this.distance, this.minDistance, this.maxDistance);
    this.target[0] = clamp(this.target[0], -this.bounds, this.bounds);
    this.target[2] = clamp(this.target[2], -this.bounds, this.bounds);

    const cp = Math.cos(this.pitch);
    this.eye = vec3.add(this.target, [
      this.distance * cp * Math.sin(this.yaw),
      this.distance * Math.sin(this.pitch),
      this.distance * cp * Math.cos(this.yaw),
    ]);
    mat4LookAt(this.view, this.eye, this.target, [0, 1, 0]);
    // Near/far scale with zoom to keep depth precision good on mobile GPUs.
    mat4Perspective(this.proj, this.fovy, this.aspect, this.distance * 0.05, this.distance * 12 + 500);
    mat4Multiply(this.viewProj, this.proj, this.view);
    mat4Invert(this.invViewProj, this.viewProj);
  }

  /** Ray through a point in normalized device coordinates (x,y in [-1,1], y up). */
  ray(ndcX: number, ndcY: number): Ray {
    const near = mat4TransformPoint(this.invViewProj, [ndcX, ndcY, -1]);
    const far = mat4TransformPoint(this.invViewProj, [ndcX, ndcY, 1]);
    return { origin: near, dir: vec3.normalize(vec3.sub(far, near)) };
  }

  /** Intersection of the screen ray with the ground plane y=0, or null near/above the horizon. */
  groundHit(ndcX: number, ndcY: number): Vec3 | null {
    const { origin, dir } = this.ray(ndcX, ndcY);
    if (dir[1] > -1e-4) return null;
    const t = -origin[1] / dir[1];
    if (t > this.distance * 10) return null; // too close to the horizon to be useful
    return vec3.add(origin, vec3.scale(dir, t));
  }
}

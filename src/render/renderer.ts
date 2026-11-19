import { type Vec3, vec3 } from '../core/math';
import { Mesh } from '../gl/mesh';
import { Program } from '../gl/program';
import type { OrbitCamera } from './camera';
import { boxGeometry, planeGeometry } from './geometry';
import { groundFS, groundVS, litFS, litInstancedVS } from './shaders';

export const BACKGROUND: Vec3 = [0.14, 0.145, 0.18];
const SUN_DIR = vec3.normalize([0.45, 0.8, 0.35]);
const SUN_COLOR: Vec3 = [1.0, 0.92, 0.8];
const SKY_COLOR: Vec3 = [0.85, 0.9, 1.0];
const GROUND_BOUNCE: Vec3 = [0.6, 0.55, 0.45];

/** Floats per box instance: posRot(4) + scale(3) + color(3). */
export const BOX_STRIDE = 10;

export class Renderer {
  private readonly groundProg: Program;
  private readonly litProg: Program;
  private readonly ground: Mesh;
  readonly boxes: Mesh;
  drawCalls = 0;

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.groundProg = new Program(gl, groundVS, groundFS, 'ground');
    this.litProg = new Program(gl, litInstancedVS, litFS, 'lit');

    const plane = planeGeometry(4000);
    this.ground = new Mesh(gl, plane.vertices, [{ loc: 0, size: 3 }], plane.indices);

    const box = boxGeometry();
    this.boxes = new Mesh(gl, box.vertices, [{ loc: 0, size: 3 }, { loc: 1, size: 3 }], box.indices, [
      { loc: 3, size: 4 },
      { loc: 4, size: 3 },
      { loc: 5, size: 3 },
    ]);
  }

  render(cam: OrbitCamera, width: number, height: number): void {
    const gl = this.gl;
    this.drawCalls = 0;
    gl.viewport(0, 0, width, height);
    gl.clearColor(BACKGROUND[0], BACKGROUND[1], BACKGROUND[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);

    const fogStart = cam.distance * 1.6;
    const fogEnd = cam.distance * 4.5;

    this.groundProg.use()
      .mat4('uViewProj', cam.viewProj)
      .vec3('uCamPos', cam.eye)
      .vec3('uFogColor', BACKGROUND)
      .vec2('uFog', fogStart, fogEnd);
    this.ground.draw();
    this.drawCalls++;

    this.litProg.use()
      .mat4('uViewProj', cam.viewProj)
      .vec3('uCamPos', cam.eye)
      .vec3('uFogColor', BACKGROUND)
      .vec2('uFog', fogStart, fogEnd)
      .vec3('uSunDir', SUN_DIR)
      .vec3('uSunColor', SUN_COLOR)
      .vec3('uSkyColor', SKY_COLOR)
      .vec3('uGroundColor', GROUND_BOUNCE);
    this.boxes.draw();
    this.drawCalls++;
  }
}

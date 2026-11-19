import { type City, type KitName, LIT_STRIDE, SHADOW_STRIDE } from '../env/city';
import { BACKGROUND, GROUND_BOUNCE, SKY_COLOR, SUN_COLOR, SUN_DIR } from '../env/style';
import type { Zone } from '../env/zone';
import { type Attrib, Mesh } from '../gl/mesh';
import { Program } from '../gl/program';
import type { OrbitCamera } from './camera';
import {
  type Geometry, boxGeometry, carGeometry, coneGeometry, crownGeometry, planeGeometry, roofGeometry,
} from './geometry';
import type { MeshData } from './roadMesh';
import { groundFS, groundVS, litFS, litInstancedVS, roadFS, roadVS, shadowFS, shadowVS } from './shaders';

export { BACKGROUND };

const POS_NORMAL: Attrib[] = [{ loc: 0, size: 3 }, { loc: 1, size: 3 }];
const LIT_INSTANCE: Attrib[] = [{ loc: 3, size: 4 }, { loc: 4, size: 3 }, { loc: 5, size: 3 }, { loc: 8, size: 1 }];
const SHADOW_INSTANCE: Attrib[] = [{ loc: 3, size: 4 }, { loc: 4, size: 2 }, { loc: 5, size: 2 }];
const KITS: Record<KitName, () => Geometry> = {
  box: boxGeometry, roof: roofGeometry, crown: crownGeometry, cone: coneGeometry,
};

export class Renderer {
  private readonly groundProg: Program;
  private readonly roadProg: Program;
  private readonly litProg: Program;
  private readonly shadowProg: Program;
  private readonly ground: Mesh;
  private readonly kits: Record<KitName, Mesh>;
  private readonly shadows: Mesh;
  private readonly vehicles: Mesh;
  private readonly props: Mesh;
  private readonly litMeshes: Mesh[];
  private readonly reserved = new Set<Mesh>();
  private roads: Mesh | null = null;
  private zone: Zone = { cx: 0, cz: 0, hx: 1e5, hz: 1e5, radius: 0, contextScale: 2 };
  drawCalls = 0;

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.groundProg = new Program(gl, groundVS, groundFS, 'ground');
    this.roadProg = new Program(gl, roadVS, roadFS, 'road');
    this.litProg = new Program(gl, litInstancedVS, litFS, 'lit');
    this.shadowProg = new Program(gl, shadowVS, shadowFS, 'shadow');

    const plane = planeGeometry(4000);
    this.ground = new Mesh(gl, plane.vertices, [{ loc: 0, size: 3 }], plane.indices);

    const quad = planeGeometry(1);
    this.shadows = new Mesh(gl, quad.vertices, [{ loc: 0, size: 3 }], quad.indices, SHADOW_INSTANCE);

    const kits = {} as Record<KitName, Mesh>;
    for (const [name, make] of Object.entries(KITS) as [KitName, () => Geometry][]) {
      const g = make();
      kits[name] = new Mesh(gl, g.vertices, POS_NORMAL, g.indices, LIT_INSTANCE);
    }
    this.kits = kits;

    const car = carGeometry();
    this.vehicles = new Mesh(gl, car.vertices, POS_NORMAL, car.indices, LIT_INSTANCE);
    const box = boxGeometry();
    this.props = new Mesh(gl, box.vertices, POS_NORMAL, box.indices, LIT_INSTANCE);
    this.litMeshes = [...Object.values(this.kits), this.vehicles, this.props];
  }

  /**
   * Per-frame instance upload. `data` should be the same preallocated buffer every frame: the first
   * call reserves GPU space for all of it, later calls upload only `count` instances.
   */
  private upload(mesh: Mesh, data: Float32Array, count: number): void {
    if (!this.reserved.has(mesh)) {
      mesh.setInstances(data, count);
      this.reserved.add(mesh);
    } else {
      mesh.setInstances(data.subarray(0, count * LIT_STRIDE), count);
    }
  }

  setVehicles(data: Float32Array, count: number): void {
    this.upload(this.vehicles, data, count);
  }

  /** Junction furniture (lines, poles, signs, signal lamps). */
  setProps(data: Float32Array, count: number): void {
    this.upload(this.props, data, count);
  }

  setZone(zone: Zone): void {
    this.zone = zone;
  }

  setRoads(data: MeshData): void {
    this.roads?.dispose();
    this.roads = new Mesh(this.gl, data.vertices, [
      { loc: 0, size: 3 }, { loc: 1, size: 3 }, { loc: 2, size: 2 }, { loc: 6, size: 3 }, { loc: 7, size: 1 },
    ], data.indices);
  }

  setCity(city: City): void {
    for (const name of Object.keys(this.kits) as KitName[]) {
      const data = city.kits[name];
      this.kits[name].setInstances(data, data.length / LIT_STRIDE);
    }
    this.shadows.setInstances(city.shadows, city.shadows.length / SHADOW_STRIDE);
  }

  /** Uniforms shared by every program (unused ones are silently ignored by WebGL). */
  private common(p: Program, cam: OrbitCamera, time: number): Program {
    const z = this.zone;
    return p.use()
      .mat4('uViewProj', cam.viewProj)
      .vec3('uCamPos', cam.eye)
      .vec3('uBg', BACKGROUND)
      .vec2('uFog', cam.distance * 2.2, cam.distance * 6)
      .vec3('uSunDir', SUN_DIR)
      .vec3('uSunColor', SUN_COLOR)
      .vec3('uSkyColor', SKY_COLOR)
      .vec3('uGroundColor', GROUND_BOUNCE)
      .vec4('uZone', z.cx, z.cz, z.hx, z.hz)
      .vec3('uZoneShape', [z.radius, z.contextScale, time]);
  }

  render(cam: OrbitCamera, width: number, height: number, time: number): void {
    const gl = this.gl;
    this.drawCalls = 0;
    gl.viewport(0, 0, width, height);
    gl.clearColor(BACKGROUND[0], BACKGROUND[1], BACKGROUND[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    gl.depthMask(true);

    this.common(this.groundProg, cam, time);
    this.ground.draw();
    this.drawCalls++;

    if (this.roads) {
      this.common(this.roadProg, cam, time);
      this.roads.draw();
      this.drawCalls++;
    }

    this.common(this.litProg, cam, time);
    for (const kit of this.litMeshes) {
      if (kit.instanceCount === 0) continue;
      kit.draw();
      this.drawCalls++;
    }

    // Soft contact shadows last: blended, depth-tested but not written.
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    this.common(this.shadowProg, cam, time);
    this.shadows.draw();
    this.drawCalls++;
    gl.depthMask(true);
    gl.disable(gl.BLEND);
  }
}

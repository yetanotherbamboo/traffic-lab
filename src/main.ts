import { FixedLoop } from './core/loop';
import type { Vec3 } from './core/math';
import { LIT_STRIDE } from './env/city';
import { formatMoney } from './editor/cost';
import { Editor } from './editor/editor';
import { TEST_SEED, TEST_ZONE, buildTestNetwork, testSpawners } from './game/testScene';
import { World } from './game/world';
import { type VehicleCounts, writeVehicleInstances } from './render/vehicles';
import { JunctionProps } from './render/junctionProps';
import { GLOW_STRIDE, type LightCounts, writeVehicleLights } from './render/lights';
import { OverlayBuilder } from './render/overlay';
import { CameraController } from './input/cameraController';
import { OrbitCamera } from './render/camera';
import { Renderer } from './render/renderer';
import { buildRoadMesh } from './render/roadMesh';
import { buildEditorOverlay } from './ui/editorOverlay';
import { EditorUI } from './ui/editorUI';

const SIM_STEP = 0.1; // 10 Hz simulation tick
const FINGER_PX = 26; // pick tolerance, CSS pixels

const canvas = document.getElementById('gl') as HTMLCanvasElement;
const hud = document.getElementById('hud') as HTMLDivElement;

const gl = canvas.getContext('webgl2', { antialias: true, alpha: false, powerPreference: 'high-performance' });
if (!gl) {
  hud.textContent = 'WebGL 2 is not supported on this device.';
  throw new Error('WebGL2 unavailable');
}

const zone = TEST_ZONE;
const camera = new OrbitCamera();
camera.bounds = zone.hx * zone.contextScale;
camera.maxDistance = 450;
const controls = new CameraController(canvas, camera);

const t0 = performance.now();
const world = new World(buildTestNetwork(), zone, TEST_SEED, testSpawners);
const genMs = performance.now() - t0;
for (let i = 0; i < 900; i++) world.sim.step(SIM_STEP); // warm up 90 s so the streets aren't empty
const vehicleData = new Float32Array(world.sim.capacity * LIT_STRIDE);
const vanData = new Float32Array(world.sim.capacity * LIT_STRIDE);
const vehicleCounts: VehicleCounts = { cars: 0, vans: 0 };
// Blinkers: up to 2 lamps per vehicle; glows for those plus every signal lamp.
const MAX_LAMP_GLOWS = 1024;
const lightData = new Float32Array(world.sim.capacity * 2 * LIT_STRIDE);
const glowData = new Float32Array((world.sim.capacity * 2 + MAX_LAMP_GLOWS) * GLOW_STRIDE);
const lightCounts: LightCounts = { boxes: 0, glows: 0 };
let props = new JunctionProps(world.sim);

// ---------------------------------------------------------------- editor
const editor = new Editor(world);
const ui = new EditorUI(editor, world);
const overlay = new OverlayBuilder();

/** Ground point under a screen position (CSS px) and a finger-sized tolerance there, in metres. */
function ground(x: number, y: number): { p: Vec3; tol: number } | null {
  const r = canvas.getBoundingClientRect();
  const p = camera.groundHit(((x - r.left) / r.width) * 2 - 1, 1 - ((y - r.top) / r.height) * 2);
  if (!p) return null;
  const dist = Math.hypot(p[0] - camera.eye[0], p[1] - camera.eye[1], p[2] - camera.eye[2]);
  const metresPerPx = (2 * dist * Math.tan(camera.fovy / 2)) / r.height;
  return { p, tol: Math.max(1.5, FINGER_PX * metresPerPx) };
}

controls.tool = {
  down: (x, y) => {
    if (!editor.dragTool) return false;
    const g = ground(x, y);
    return !!g && editor.down(g.p, g.tol);
  },
  move: (x, y) => {
    const g = ground(x, y);
    if (g) editor.move(g.p, g.tol);
  },
  up: () => editor.up(),
  cancel: () => editor.cancel(),
  tap: (x, y) => {
    const g = ground(x, y);
    if (g) editor.tap(g.p, g.tol);
  },
  hover: (x, y) => {
    const g = ground(x, y);
    editor.hoverAt(g?.p ?? null, g?.tol ?? 0);
  },
};

// Dev builds: expose internals for debugging in the browser console (stripped from production).
if (import.meta.env.DEV) Object.assign(window, { __tl: { camera, world, editor } });

// ---------------------------------------------------------------- rendering
let renderer: Renderer;
let roadsShown: unknown = null; // network whose mesh is on the GPU (live or a draft preview)
let seenWorld = -1, seenCity = -1, seenEditor = -1;

function initGL(): void {
  renderer = new Renderer(gl!);
  renderer.setZone(zone);
  renderer.setCity(world.city);
  roadsShown = null;
  seenWorld = seenCity = seenEditor = -1;
}

/** Re-uploads whatever the editor or the world changed since the last frame. */
function syncScene(): void {
  if (world.version !== seenWorld) {
    seenWorld = world.version;
    props = new JunctionProps(world.sim);
  }
  if (world.cityVersion !== seenCity) {
    seenCity = world.cityVersion;
    renderer.setCity(world.city);
  }
  // While dragging, the road mesh shows the draft so new junctions form under the finger.
  const shown = editor.draft?.candidate ?? world.net;
  if (shown !== roadsShown) {
    roadsShown = shown;
    renderer.setRoads(buildRoadMesh(shown));
  }
  const ev = editor.version * 100000 + world.version;
  if (ev !== seenEditor) {
    seenEditor = ev;
    buildEditorOverlay(overlay, editor, world);
    renderer.setOverlay(overlay.buffer, overlay.count);
    // Desktop: the mouse pointer says when a road can't start under it.
    const cursor = editor.hover?.kind === 'blocked' ? 'not-allowed' : '';
    if (canvas.style.cursor !== cursor) canvas.style.cursor = cursor;
  }
  ui.update();
}

function resize(): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.round(canvas.clientWidth * dpr);
  const h = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
}

let fps = 60;
let hudTimer = 0;
let time = 0;
const loop = new FixedLoop(
  SIM_STEP,
  (dt) => world.sim.step(dt),
  (alpha, frameDt) => {
    time += frameDt;
    resize();
    world.animate(frameDt);
    syncScene();
    camera.update(canvas.width / canvas.height);
    writeVehicleInstances(world.sim, alpha, vehicleData, vanData, vehicleCounts);
    renderer.setVehicles(vehicleData, vehicleCounts.cars, vanData, vehicleCounts.vans);
    renderer.setProps(props.buffer, props.update());
    const lamps = props.lampCount <= MAX_LAMP_GLOWS ? props.writeGlows(glowData, 0) : 0;
    writeVehicleLights(world.sim, alpha, time, lightData, glowData, lamps, lightCounts);
    renderer.setLights(lightData, lightCounts.boxes);
    renderer.setGlows(glowData, lamps + lightCounts.glows);
    renderer.render(camera, canvas.width, canvas.height, time);

    if (frameDt > 0) fps += (1 / frameDt - fps) * 0.05;
    hudTimer += frameDt;
    if (hudTimer > 0.25) {
      hudTimer = 0;
      const s = world.sim.stats;
      hud.textContent =
        `${fps.toFixed(0)} fps · ${renderer.drawCalls} draws · ${canvas.width}×${canvas.height}\n` +
        `${world.city.lots.length} lots · city ${genMs.toFixed(0)} ms · spent ${formatMoney(world.spent)}\n` +
        `${s.vehicles} vehicles · avg ${(s.meanSpeed * 3.6).toFixed(0)} km/h · ${s.waiting} waiting · ${s.exited} done`;
    }
  },
);

canvas.addEventListener('webglcontextlost', (e) => {
  e.preventDefault();
  loop.stop();
});
canvas.addEventListener('webglcontextrestored', () => {
  initGL();
  loop.start();
});
document.addEventListener('visibilitychange', () => (document.hidden ? loop.stop() : loop.start()));

try {
  initGL();
  loop.start();
} catch (err) {
  hud.textContent = `Startup error:\n${err instanceof Error ? err.message : String(err)}`;
  throw err;
}

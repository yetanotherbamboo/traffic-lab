import { FixedLoop } from './core/loop';
import { LIT_STRIDE, generateCity } from './env/city';
import { TEST_SEED, TEST_ZONE, buildTestNetwork, testSpawners } from './game/testScene';
import { LaneGraph } from './sim/laneGraph';
import { TrafficSim } from './sim/traffic';
import { writeVehicleInstances } from './render/vehicles';
import { JunctionProps } from './render/junctionProps';
import { CameraController } from './input/cameraController';
import { OrbitCamera } from './render/camera';
import { Renderer } from './render/renderer';
import { buildRoadMesh } from './render/roadMesh';

const SIM_STEP = 0.1; // 10 Hz simulation tick

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
new CameraController(canvas, camera);

const network = buildTestNetwork();
const t0 = performance.now();
const city = generateCity(network, zone, TEST_SEED);
const genMs = performance.now() - t0;

const lanes = new LaneGraph(network);
const sim = new TrafficSim(lanes, testSpawners(network), TEST_SEED);
for (let i = 0; i < 900; i++) sim.step(SIM_STEP); // warm up 90 s so the streets aren't empty
const vehicleData = new Float32Array(sim.capacity * LIT_STRIDE);
const props = new JunctionProps(sim);

let renderer: Renderer;
function initGL(): void {
  renderer = new Renderer(gl!);
  renderer.setZone(zone);
  renderer.setRoads(buildRoadMesh(network));
  renderer.setCity(city);
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
  (dt) => sim.step(dt),
  (alpha, frameDt) => {
    time += frameDt;
    resize();
    camera.update(canvas.width / canvas.height);
    renderer.setVehicles(vehicleData, writeVehicleInstances(sim, alpha, vehicleData));
    renderer.setProps(props.buffer, props.update());
    renderer.render(camera, canvas.width, canvas.height, time);

    if (frameDt > 0) fps += (1 / frameDt - fps) * 0.05;
    hudTimer += frameDt;
    if (hudTimer > 0.25) {
      hudTimer = 0;
      hud.textContent =
        `${fps.toFixed(0)} fps · ${renderer.drawCalls} draws · ${canvas.width}×${canvas.height}\n` +
        `${city.lots.length} lots · city ${genMs.toFixed(0)} ms\n` +
        `${sim.stats.vehicles} vehicles · avg ${(sim.stats.meanSpeed * 3.6).toFixed(0)} km/h · ` +
        `${sim.stats.waiting} waiting · ${sim.stats.exited} done`;
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

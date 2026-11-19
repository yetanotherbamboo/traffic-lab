import { FixedLoop } from './core/loop';
import { CameraController } from './input/cameraController';
import { OrbitCamera } from './render/camera';
import { buildTestNetwork, testBoxes } from './game/testScene';
import { BOX_STRIDE, Renderer } from './render/renderer';
import { buildRoadMesh } from './render/roadMesh';

const SIM_STEP = 0.1; // 10 Hz simulation tick

const canvas = document.getElementById('gl') as HTMLCanvasElement;
const hud = document.getElementById('hud') as HTMLDivElement;

const gl = canvas.getContext('webgl2', { antialias: true, alpha: false, powerPreference: 'high-performance' });
if (!gl) {
  hud.textContent = 'WebGL 2 is not supported on this device.';
  throw new Error('WebGL2 unavailable');
}

const camera = new OrbitCamera();
new CameraController(canvas, camera);

const network = buildTestNetwork();

let renderer: Renderer;
function initGL(): void {
  renderer = new Renderer(gl!);
  const boxes = testBoxes();
  renderer.boxes.setInstances(boxes, boxes.length / BOX_STRIDE);
  renderer.setRoads(buildRoadMesh(network));
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
const loop = new FixedLoop(
  SIM_STEP,
  () => {
    /* simulation goes here (Milestone 3) */
  },
  (_alpha, frameDt) => {
    resize();
    camera.update(canvas.width / canvas.height);
    renderer.render(camera, canvas.width, canvas.height);

    if (frameDt > 0) fps += (1 / frameDt - fps) * 0.05;
    hudTimer += frameDt;
    if (hudTimer > 0.25) {
      hudTimer = 0;
      hud.textContent = `${fps.toFixed(0)} fps · ${renderer.drawCalls} draws · ${canvas.width}×${canvas.height}`;
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
  hud.style.whiteSpace = 'pre-wrap';
  hud.textContent = `Startup error:\n${err instanceof Error ? err.message : String(err)}`;
  throw err;
}

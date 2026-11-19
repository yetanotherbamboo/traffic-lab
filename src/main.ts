import { FixedLoop } from './core/loop';
import { CameraController } from './input/cameraController';
import { OrbitCamera } from './render/camera';
import { BOX_STRIDE, Renderer } from './render/renderer';

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

/** Test scene: a ring of pastel boxes of different sizes. */
function testBoxes(): Float32Array {
  const palette = [
    [0.95, 0.78, 0.62], [0.78, 0.86, 0.93], [0.96, 0.9, 0.7],
    [0.85, 0.75, 0.88], [0.98, 0.7, 0.6], [0.75, 0.88, 0.78],
  ];
  const count = 24;
  const data = new Float32Array(count * BOX_STRIDE);
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    const r = 30 + (i % 3) * 18;
    const c = palette[i % palette.length]!;
    data.set([
      Math.cos(a) * r, 0, Math.sin(a) * r, -a,
      8 + (i % 4) * 3, 4 + ((i * 7) % 5) * 5, 8 + (i % 2) * 4,
      c[0]!, c[1]!, c[2]!,
    ], i * BOX_STRIDE);
  }
  return data;
}

let renderer: Renderer;
function initGL(): void {
  renderer = new Renderer(gl!);
  const boxes = testBoxes();
  renderer.boxes.setInstances(boxes, boxes.length / BOX_STRIDE);
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

initGL();
loop.start();

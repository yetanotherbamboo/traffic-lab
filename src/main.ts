const canvas = document.getElementById('gl') as HTMLCanvasElement;
const hud = document.getElementById('hud') as HTMLDivElement;

const gl = canvas.getContext('webgl2', { antialias: true, alpha: false, powerPreference: 'high-performance' });
if (!gl) {
  hud.textContent = 'WebGL 2 is not supported on this device.';
  throw new Error('WebGL2 unavailable');
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

function frame(): void {
  resize();
  gl!.viewport(0, 0, canvas.width, canvas.height);
  gl!.clearColor(0.93, 0.89, 0.82, 1);
  gl!.clear(gl!.COLOR_BUFFER_BIT);
  hud.textContent = `Traffic Lab · WebGL2 OK · ${canvas.width}×${canvas.height}`;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

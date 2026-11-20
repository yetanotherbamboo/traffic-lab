import { vec3 } from '../core/math';
import type { OrbitCamera } from '../render/camera';

interface Pt {
  x: number;
  y: number;
  button: number;
}

/**
 * Hooks for an editing tool. Screen coordinates are CSS pixels (clientX/Y).
 *  - `down` is offered every single-finger / left-button press; returning true claims the drag
 *    (the camera stays put) until `up`, or `cancel` if a second finger joins.
 *  - `tap` fires for short presses that weren't claimed and barely moved.
 *  - `hover` reports mouse movement with no button pressed.
 */
export interface PointerTool {
  down(x: number, y: number): boolean;
  move(x: number, y: number): void;
  up(x: number, y: number): void;
  cancel(): void;
  tap(x: number, y: number): void;
  hover(x: number, y: number): void;
}

const TAP_MOVE = 10; // px
const TAP_TIME = 450; // ms

/**
 * Touch + mouse camera controls.
 *  Touch: 1 finger = pan (ground stays under the finger),
 *         2 fingers = pinch zoom, twist rotate, vertical drag tilts.
 *  Mouse: left drag = pan, right drag (or Shift+left) = rotate/tilt, wheel = zoom to cursor.
 */
export class CameraController {
  private readonly pointers = new Map<number, Pt>();
  private shiftOrbit = false;
  /** Editing tool hooks (null = camera only). */
  tool: PointerTool | null = null;
  private claimed = false;
  private gesture = { x: 0, y: 0, t: 0, tap: false };

  constructor(private readonly canvas: HTMLCanvasElement, private readonly cam: OrbitCamera) {
    canvas.addEventListener('pointerdown', this.onDown);
    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointercancel', this.onUp);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private ndc(x: number, y: number): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [((x - r.left) / r.width) * 2 - 1, 1 - ((y - r.top) / r.height) * 2];
  }

  /** Move the camera so the ground point under (ax,ay) ends up under (bx,by). */
  private dragGround(ax: number, ay: number, bx: number, by: number): void {
    const a = this.cam.groundHit(...this.ndc(ax, ay));
    const b = this.cam.groundHit(...this.ndc(bx, by));
    if (!a || !b) return;
    this.cam.target = vec3.add(this.cam.target, vec3.sub(a, b));
    this.cam.target[1] = 0;
    this.cam.update();
  }

  /** Zoom by `factor` (>1 = closer) keeping the ground point under (x,y) fixed. */
  private zoomAt(x: number, y: number, factor: number): void {
    const before = this.cam.groundHit(...this.ndc(x, y));
    this.cam.distance /= factor;
    this.cam.update();
    const after = this.cam.groundHit(...this.ndc(x, y));
    if (before && after) {
      this.cam.target = vec3.add(this.cam.target, vec3.sub(before, after));
      this.cam.target[1] = 0;
      this.cam.update();
    }
  }

  private rotate(dx: number, dy: number): void {
    this.cam.yaw -= dx * 0.006;
    this.cam.pitch += dy * 0.005;
    this.cam.update();
  }

  private onDown = (e: PointerEvent): void => {
    this.canvas.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, button: e.button });
    this.shiftOrbit = e.shiftKey;
    if (this.pointers.size === 1) {
      this.gesture = { x: e.clientX, y: e.clientY, t: performance.now(), tap: e.button === 0 && !e.shiftKey };
      this.claimed = !!this.tool && e.button === 0 && !e.shiftKey && this.tool.down(e.clientX, e.clientY);
    } else {
      this.gesture.tap = false;
      if (this.claimed) {
        this.claimed = false;
        this.tool?.cancel();
      }
    }
  };

  private onMove = (e: PointerEvent): void => {
    const p = this.pointers.get(e.pointerId);
    if (!p) {
      if (this.pointers.size === 0 && e.pointerType === 'mouse') this.tool?.hover(e.clientX, e.clientY);
      return;
    }
    const nx = e.clientX, ny = e.clientY;
    if (Math.hypot(nx - this.gesture.x, ny - this.gesture.y) > TAP_MOVE) this.gesture.tap = false;

    if (this.claimed) {
      if (this.pointers.size === 1) this.tool?.move(nx, ny);
    } else if (this.pointers.size === 1) {
      if (e.pointerType === 'mouse' && (p.button === 2 || this.shiftOrbit)) {
        this.rotate(nx - p.x, ny - p.y);
      } else {
        this.dragGround(p.x, p.y, nx, ny);
      }
    } else if (this.pointers.size === 2) {
      const other = [...this.pointers.entries()].find(([id]) => id !== e.pointerId)![1];
      const d0 = Math.hypot(p.x - other.x, p.y - other.y);
      const d1 = Math.hypot(nx - other.x, ny - other.y);
      const a0 = Math.atan2(p.y - other.y, p.x - other.x);
      const a1 = Math.atan2(ny - other.y, nx - other.x);
      let da = a1 - a0;
      if (da > Math.PI) da -= 2 * Math.PI;
      if (da < -Math.PI) da += 2 * Math.PI;
      const mx = (nx + other.x) / 2, my = (ny + other.y) / 2;

      if (d0 > 1 && d1 > 1) this.zoomAt(mx, my, d1 / d0);
      this.cam.yaw += da;
      this.cam.pitch += ((ny - p.y) / 2) * 0.006; // midpoint vertical motion → tilt
      this.cam.update();
    }

    p.x = nx;
    p.y = ny;
  };

  private onUp = (e: PointerEvent): void => {
    if (!this.pointers.delete(e.pointerId)) return;
    if (this.pointers.size > 0) return;
    if (this.claimed) {
      this.claimed = false;
      if (e.type === 'pointercancel') this.tool?.cancel();
      else this.tool?.up(e.clientX, e.clientY);
    } else if (this.gesture.tap && e.type === 'pointerup' && performance.now() - this.gesture.t < TAP_TIME) {
      this.tool?.tap(e.clientX, e.clientY);
    }
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    this.zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015));
  };
}

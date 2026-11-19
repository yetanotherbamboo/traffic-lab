/**
 * Fixed-timestep loop: `update` runs at a constant rate (deterministic simulation),
 * `render` runs once per display frame with an interpolation factor in [0, 1).
 */
export class FixedLoop {
  private acc = 0;
  private last = 0;
  private raf = 0;
  private running = false;

  constructor(
    private readonly step: number,
    private readonly update: (dt: number) => void,
    private readonly render: (alpha: number, frameDt: number) => void,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    this.acc = 0;
    this.raf = requestAnimationFrame(this.tick);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  private tick = (now: number): void => {
    if (!this.running) return;
    // Clamp long gaps (tab switch, debugger) to avoid a catch-up spiral.
    const frameDt = Math.min((now - this.last) / 1000, 0.25);
    this.last = now;
    this.acc += frameDt;
    while (this.acc >= this.step) {
      this.update(this.step);
      this.acc -= this.step;
    }
    this.render(this.acc / this.step, frameDt);
    this.raf = requestAnimationFrame(this.tick);
  };
}

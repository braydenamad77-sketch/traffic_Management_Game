import { V, clamp } from './vec';
import { WORLD_W, WORLD_H } from './terrain';

export class Camera {
  x = WORLD_W / 2;
  y = WORLD_H / 2;
  zoom = 2.2;        // px per world unit

  constructor(public canvas: HTMLCanvasElement) {}

  toWorld(sx: number, sy: number): V {
    const r = this.canvas.getBoundingClientRect();
    return {
      x: (sx - r.width / 2) / this.zoom + this.x,
      y: (sy - r.height / 2) / this.zoom + this.y,
    };
  }

  toScreen(p: V): V {
    const r = this.canvas.getBoundingClientRect();
    return {
      x: (p.x - this.x) * this.zoom + r.width / 2,
      y: (p.y - this.y) * this.zoom + r.height / 2,
    };
  }

  pan(dx: number, dy: number) {
    this.x -= dx / this.zoom;
    this.y -= dy / this.zoom;
    this.clampView();
  }

  zoomAt(sx: number, sy: number, factor: number) {
    const before = this.toWorld(sx, sy);
    this.zoom = clamp(this.zoom * factor, 0.8, 14);
    const after = this.toWorld(sx, sy);
    this.x += before.x - after.x;
    this.y += before.y - after.y;
    this.clampView();
  }

  private clampView() {
    const m = 80;
    this.x = clamp(this.x, -m, WORLD_W + m);
    this.y = clamp(this.y, -m, WORLD_H + m);
  }

  /** apply transform to ctx (call after clearing) */
  apply(ctx: CanvasRenderingContext2D, dpr: number) {
    const r = this.canvas.getBoundingClientRect();
    ctx.setTransform(
      this.zoom * dpr, 0, 0, this.zoom * dpr,
      (r.width / 2 - this.x * this.zoom) * dpr,
      (r.height / 2 - this.y * this.zoom) * dpr,
    );
  }
}

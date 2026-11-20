import type { Vec3 } from '../core/math';
import { Rng } from '../core/rng';
import { type RoadNetwork, horizontal, rightOf } from '../network/network';
import { PALETTE, SUN_DIR } from './style';
import { type Zone, contextDistance, zoneDistance } from './zone';

/** Floats per lit instance: posRot(4) + scale(3) + color(3) + kind(1). */
export const LIT_STRIDE = 11;
/** Floats per shadow decal: posRot(4) + size(2) + softness(1) + opacity(1). */
export const SHADOW_STRIDE = 8;

/** Instance `kind`: 0 = plain surface, 1 = building facade (shader draws windows). */
export const KIND_PLAIN = 0;
export const KIND_FACADE = 1;
export const KIND_VEHICLE = 2;
/** Unlit, self-coloured (signal lamps, blinkers, editor overlay). Keep in sync with litFS. */
export const KIND_EMISSIVE = 3;
export const KIND_VAN = 4;

export type LotKind = 'house' | 'shop' | 'midrise' | 'park';
export type KitName = 'box' | 'roof' | 'crown' | 'cone';

/** Oriented rectangle on the ground. `angle` follows the shader convention (rotation about +Y). */
export interface Lot {
  cx: number;
  cz: number;
  hx: number;
  hz: number;
  angle: number;
  kind: LotKind;
  /** True when the lot centre lies in the construction area (demolishable later). */
  inZone: boolean;
}

/**
 * Something on the ground that a new road can demolish: a lot (building or park) or a tree,
 * with the instance ranges it occupies in the kit and shadow buffers.
 */
export interface CityItem {
  id: number;
  kind: LotKind | 'tree';
  /** Footprint: the lot rectangle, or a tree's centre and radius. */
  lot: Lot | null;
  x: number;
  z: number;
  r: number;
  /** Top of the tallest instance (m), for the sink animation. */
  top: number;
  ranges: { kit: KitName; start: number; count: number }[];
  shadow: { start: number; count: number };
}

export interface City {
  lots: Lot[];
  items: CityItem[];
  /** Instance data as generated; `kits` / `shadows` are the live copies with demolition applied. */
  baseKits: Record<KitName, Float32Array>;
  baseShadows: Float32Array;
  kits: Record<KitName, Float32Array>;
  shadows: Float32Array;
}

const LOT_DIMS: Record<LotKind, [number, number, number, number]> = {
  // frontage min/max, depth min/max (metres)
  house: [11, 15, 13, 17],
  shop: [9, 14, 14, 20],
  midrise: [18, 26, 18, 24],
  park: [16, 26, 16, 24],
};
const LOT_WEIGHTS: Record<LotKind, number> = { house: 0.45, shop: 0.25, midrise: 0.18, park: 0.12 };

const CELL = 24; // spatial hash cell size, metres

/** Road centreline piece with the clearance needed around it. */
interface Corridor {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  r: number;
  /** Asphalt extent right / left of the centreline (no sidewalk, no clearance). */
  raR: number;
  raL: number;
  seg: number;
}

function distToSegment(px: number, pz: number, c: Corridor): number {
  const dx = c.bx - c.ax, dz = c.bz - c.az;
  const len2 = dx * dx + dz * dz;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - c.ax) * dx + (pz - c.az) * dz) / len2)) : 0;
  return Math.hypot(px - (c.ax + dx * t), pz - (c.az + dz * t));
}

/** 'roads' = road corridors incl. sidewalks, 'asphalt' = carriageways only, 'junctions' = junction areas. */
export type MaskPart = 'all' | 'roads' | 'asphalt' | 'junctions';

/** Answers "is this ground point on a road / junction?" quickly via a spatial hash. */
class RoadMask {
  private readonly cells = new Map<string, Corridor[]>();
  private readonly disks: [number, number, number][] = [];

  constructor(net: RoadNetwork, clearance: number) {
    for (const seg of net.segments.values()) {
      const { forward, backward, laneWidth, sidewalk } = seg.profile;
      const raR = forward * laneWidth, raL = backward * laneWidth;
      const r = Math.max(raR, raL) + sidewalk + clearance;
      const n = Math.max(1, Math.ceil(seg.curve.length / 4));
      let prev = seg.curve.point(0);
      for (let k = 1; k <= n; k++) {
        const p = seg.curve.point(seg.curve.tAtDistance((seg.curve.length * k) / n));
        this.insert({ ax: prev[0], az: prev[2], bx: p[0], bz: p[2], r, raR, raL, seg: seg.id });
        prev = p;
      }
    }
    for (const id of net.nodes.keys()) {
      if (net.isJunction(id)) {
        const p = net.node(id).pos;
        this.disks.push([p[0], p[2], net.junctionRadius(id) + clearance]);
      }
    }
  }

  private insert(c: Corridor): void {
    const x0 = Math.floor((Math.min(c.ax, c.bx) - c.r) / CELL), x1 = Math.floor((Math.max(c.ax, c.bx) + c.r) / CELL);
    const z0 = Math.floor((Math.min(c.az, c.bz) - c.r) / CELL), z1 = Math.floor((Math.max(c.az, c.bz) + c.r) / CELL);
    for (let x = x0; x <= x1; x++) {
      for (let z = z0; z <= z1; z++) {
        const key = `${x},${z}`;
        const list = this.cells.get(key);
        if (list) list.push(c);
        else this.cells.set(key, [c]);
      }
    }
  }

  /**
   * True if (x,z) is within `extra` metres of road clearance. `ignoreSeg` skips one road; `use`
   * limits the test to road corridors or junction areas.
   */
  blocked(x: number, z: number, extra = 0, ignoreSeg = -1, use: MaskPart = 'all'): boolean {
    if (use !== 'junctions') {
      const list = this.cells.get(`${Math.floor(x / CELL)},${Math.floor(z / CELL)}`);
      if (list) {
        for (const c of list) {
          if (c.seg === ignoreSeg) continue;
          let reach = c.r;
          if (use === 'asphalt') {
            // Which side of the centreline: right of the direction a → b is (-dz, dx).
            const side = -(c.bz - c.az) * (x - c.ax) + (c.bx - c.ax) * (z - c.az);
            reach = side >= 0 ? c.raR : c.raL;
          }
          if (distToSegment(x, z, c) < reach + extra) return true;
        }
      }
    }
    if (use === 'all' || use === 'junctions') {
      for (const [dx, dz, r] of this.disks) if (Math.hypot(x - dx, z - dz) < r + extra) return true;
    }
    return false;
  }
}

/** Unit axes of a lot in world space: local x (along the street) and local z. */
function lotAxes(angle: number): [[number, number], [number, number]] {
  const c = Math.cos(angle), s = Math.sin(angle);
  return [[c, -s], [s, c]];
}

/** Separating-axis overlap test for two oriented rectangles (with optional padding). */
export function lotsOverlap(a: Lot, b: Lot, pad = 0): boolean {
  if (Math.hypot(a.cx - b.cx, a.cz - b.cz) > Math.hypot(a.hx, a.hz) + Math.hypot(b.hx, b.hz) + pad) return false;
  const [ax, az] = lotAxes(a.angle), [bx, bz] = lotAxes(b.angle);
  const dx = b.cx - a.cx, dz = b.cz - a.cz;
  for (const axis of [ax, az, bx, bz]) {
    const proj = (h: number, u: [number, number]): number => Math.abs(h * (u[0] * axis[0] + u[1] * axis[1]));
    const ra = proj(a.hx, ax) + proj(a.hz, az);
    const rb = proj(b.hx, bx) + proj(b.hz, bz);
    if (Math.abs(dx * axis[0] + dz * axis[1]) > ra + rb + pad) return false;
  }
  return true;
}

export function pointInLot(l: Lot, x: number, z: number, pad = 0): boolean {
  const [ax, az] = lotAxes(l.angle);
  const dx = x - l.cx, dz = z - l.cz;
  return Math.abs(dx * ax[0] + dz * ax[1]) <= l.hx + pad && Math.abs(dx * az[0] + dz * az[1]) <= l.hz + pad;
}

const KIT_NAMES: KitName[] = ['box', 'roof', 'crown', 'cone'];

class Emitter {
  readonly kits: Record<KitName, number[]> = { box: [], roof: [], crown: [], cone: [] };
  readonly shadows: number[] = [];
  readonly items: CityItem[] = [];
  private mark: { kits: Record<KitName, number>; shadows: number } | null = null;

  /** Starts recording the instances of one demolishable item. */
  begin(): void {
    const kits = {} as Record<KitName, number>;
    for (const k of KIT_NAMES) kits[k] = this.kits[k].length;
    this.mark = { kits, shadows: this.shadows.length };
  }

  end(kind: CityItem['kind'], lot: Lot | null, x: number, z: number, r: number): void {
    const m = this.mark!;
    const ranges: CityItem['ranges'] = [];
    let top = 0;
    for (const k of KIT_NAMES) {
      const start = m.kits[k] / LIT_STRIDE, count = (this.kits[k].length - m.kits[k]) / LIT_STRIDE;
      if (count === 0) continue;
      ranges.push({ kit: k, start, count });
      for (let i = start; i < start + count; i++) {
        top = Math.max(top, this.kits[k][i * LIT_STRIDE + 1]! + this.kits[k][i * LIT_STRIDE + 5]!);
      }
    }
    const shadow = { start: m.shadows / SHADOW_STRIDE, count: (this.shadows.length - m.shadows) / SHADOW_STRIDE };
    this.items.push({ id: this.items.length, kind, lot, x, z, r, top, ranges, shadow });
    this.mark = null;
  }

  lit(kit: KitName, p: Vec3, angle: number, scale: Vec3, color: Vec3, kind = KIND_PLAIN): void {
    this.kits[kit].push(p[0], p[1], p[2], angle, scale[0], scale[1], scale[2], color[0], color[1], color[2], kind);
  }

  /** Soft contact shadow, nudged away from the sun in proportion to object height. */
  shadow(x: number, z: number, angle: number, sx: number, sz: number, height: number, soft: number, opacity: number): void {
    const len = Math.hypot(SUN_DIR[0], SUN_DIR[2]) || 1;
    const off = Math.min(height * 0.15, 3);
    this.shadows.push(x - (SUN_DIR[0] / len) * off, 0.02, z - (SUN_DIR[2] / len) * off, angle, sx, sz, soft, opacity);
  }
}

function emitTree(e: Emitter, rng: Rng, x: number, z: number, baseY: number, small = false): void {
  const leaves = rng.chance(0.06) ? rng.pick(PALETTE.autumn) : rng.pick(PALETTE.leaves);
  const k = small ? 0.75 : 1;
  if (rng.chance(0.65)) {
    const r = rng.range(1.6, 2.6) * k, th = rng.range(1.6, 2.4) * k;
    e.lit('box', [x, baseY, z], 0, [0.35, th + r * 0.5, 0.35], PALETTE.trunk);
    e.lit('crown', [x, baseY + th - r * 0.3, z], rng.range(0, 6.28), [r, r * 0.95, r], leaves);
    e.shadow(x, z, 0, r * 2.3, r * 2.3, th + r * 2, r * 0.9, 0.32);
  } else {
    const r = rng.range(1.4, 2.0) * k, h = rng.range(4, 6.5) * k, th = rng.range(1.0, 1.5) * k;
    e.lit('box', [x, baseY, z], 0, [0.3, th + 0.5, 0.3], PALETTE.trunk);
    e.lit('cone', [x, baseY + th * 0.6, z], rng.range(0, 6.28), [r, h, r], leaves);
    e.shadow(x, z, 0, r * 2.2, r * 2.2, h, r * 0.85, 0.3);
  }
}

/** Fills a lot with its building or park. `toRoad` is the world direction from the lot to its street. */
function emitLot(e: Emitter, rng: Rng, lot: Lot, toRoad: [number, number]): void {
  const { cx, cz, hx, hz, angle } = lot;
  if (lot.kind === 'park') {
    e.lit('box', [cx, 0, cz], angle, [hx * 2 - 1, 0.06, hz * 2 - 1], PALETTE.grass);
    const [ax, az] = lotAxes(angle);
    const n = 2 + Math.floor(rng.next() * 4);
    for (let i = 0; i < n; i++) {
      const u = rng.range(-hx + 3, hx - 3), v = rng.range(-hz + 3, hz - 3);
      emitTree(e, rng, cx + ax[0] * u + az[0] * v, cz + ax[1] * u + az[1] * v, 0.06);
    }
    return;
  }

  const wall = rng.pick(PALETTE.walls);
  const bw = hx * 2 - rng.range(1.5, 3);
  const bd = hz * 2 - rng.range(2.5, 6);
  const front = rng.range(0.8, 2);
  const shift = hz - bd / 2 - front; // pull the building towards its street
  const bx = cx + toRoad[0] * shift, bz = cz + toRoad[1] * shift;

  let h: number;
  if (lot.kind === 'house') {
    h = rng.range(4, 7);
    e.lit('box', [bx, 0, bz], angle, [bw, h, bd], wall, KIND_FACADE);
    const rh = rng.range(2.2, 3.4);
    const roof = rng.pick(PALETTE.roofs);
    // Ridge runs along the longer side.
    if (bw >= bd) e.lit('roof', [bx, h, bz], angle, [bw * 1.06, rh, bd * 1.1], roof);
    else e.lit('roof', [bx, h, bz], angle + Math.PI / 2, [bd * 1.06, rh, bw * 1.1], roof);
    h += rh;
  } else {
    h = lot.kind === 'shop' ? rng.range(6, 10) : rng.range(12, 24);
    e.lit('box', [bx, 0, bz], angle, [bw, h, bd], wall, KIND_FACADE);
    const units = lot.kind === 'shop' ? 1 : 2;
    const [ax, az] = lotAxes(angle);
    for (let i = 0; i < units; i++) {
      const u = rng.range(-bw / 4, bw / 4), v = rng.range(-bd / 4, bd / 4), s = rng.range(2, 4);
      e.lit('box', [bx + ax[0] * u + az[0] * v, h, bz + ax[1] * u + az[1] * v], angle,
        [s, rng.range(1, 1.8), s * 0.8], PALETTE.roofUnit);
    }
  }
  e.shadow(bx, bz, angle, bw + 2.5, bd + 2.5, h, 1.8, 0.3);
}

/**
 * Procedurally grows a city around the road network: lots along every street side,
 * street trees on sidewalks, and trees filling the leftover space. Fully deterministic for a seed.
 */
export function generateCity(net: RoadNetwork, zone: Zone, seed: number): City {
  const rng = new Rng(seed);
  const e = new Emitter();
  const lots: Lot[] = [];
  const mask = new RoadMask(net, 0.5);
  const visible = (x: number, z: number, margin = 0): boolean => contextDistance(zone, x, z) < margin;

  const lotFree = (lot: Lot): boolean => {
    const [ax, az] = lotAxes(lot.angle);
    for (let i = 0; i <= 4; i++) {
      for (let j = 0; j <= 4; j++) {
        const u = (i / 4 - 0.5) * 2 * lot.hx, v = (j / 4 - 0.5) * 2 * lot.hz;
        if (mask.blocked(lot.cx + ax[0] * u + az[0] * v, lot.cz + ax[1] * u + az[1] * v)) return false;
      }
    }
    return !lots.some((o) => lotsOverlap(lot, o, 0.5));
  };

  // 1. Lots along both sides of every street.
  for (const seg of net.segments.values()) {
    const { forward, backward, laneWidth, sidewalk } = seg.profile;
    const len = seg.curve.length;
    for (const side of [1, -1] as const) {
      const ext = (side > 0 ? forward : backward) * laneWidth + sidewalk + 0.5;
      let s = 3;
      while (s < len - 3) {
        const kind = rng.weighted(LOT_WEIGHTS);
        const [f0, f1, d0, d1] = LOT_DIMS[kind];
        const f = rng.range(f0, f1), d = rng.range(d0, d1);
        const mid = s + f / 2;
        if (mid > len - 3) break;
        const t = seg.curve.tAtDistance(mid);
        const p = seg.curve.point(t);
        const tan = horizontal(seg.curve.derivative(t));
        const r = rightOf(tan);
        const off = ext + rng.range(0.5, 2) + d / 2;
        const cx = p[0] + r[0] * side * off, cz = p[2] + r[2] * side * off;
        const lot: Lot = {
          cx, cz, hx: f / 2, hz: d / 2, angle: Math.atan2(-tan[2], tan[0]), kind,
          inZone: zoneDistance(zone, cx, cz) < 0,
        };
        if (visible(cx, cz, 10) && lotFree(lot)) {
          lots.push(lot);
          e.begin();
          emitLot(e, rng, lot, [-r[0] * side, -r[2] * side]);
          e.end(lot.kind, lot, cx, cz, Math.hypot(lot.hx, lot.hz));
          s += f + rng.range(0.5, 3);
        } else {
          s += 3;
        }
      }
    }
  }

  // 2. Street trees on wider sidewalks.
  for (const seg of net.segments.values()) {
    const { forward, backward, laneWidth, sidewalk } = seg.profile;
    if (sidewalk < 2) continue;
    const [s0, s1] = net.trimmedRange(seg);
    for (const side of [1, -1] as const) {
      const off = (side > 0 ? forward : backward) * laneWidth + sidewalk * 0.6;
      for (let s = s0 + 5; s < s1 - 5; s += rng.range(11, 16)) {
        if (!rng.chance(0.75)) continue;
        const t = seg.curve.tAtDistance(s);
        const p = seg.curve.point(t);
        const r = rightOf(horizontal(seg.curve.derivative(t)));
        const x = p[0] + r[0] * side * off, z = p[2] + r[2] * side * off;
        if (!visible(x, z) || mask.blocked(x, z, 0, seg.id)) continue;
        e.begin();
        emitTree(e, rng, x, z, 0.18, true);
        e.end('tree', null, x, z, 1.6);
      }
    }
  }

  // 3. Fill yards and block interiors with trees.
  const s = zone.contextScale;
  for (let x = zone.cx - zone.hx * s; x <= zone.cx + zone.hx * s; x += 8) {
    for (let z = zone.cz - zone.hz * s; z <= zone.cz + zone.hz * s; z += 8) {
      const px = x + rng.range(-3, 3), pz = z + rng.range(-3, 3);
      if (!rng.chance(0.42) || !visible(px, pz)) continue;
      if (mask.blocked(px, pz, 1.5)) continue;
      if (lots.some((l) => pointInLot(l, px, pz, 1.5))) continue;
      e.begin();
      emitTree(e, rng, px, pz, 0);
      e.end('tree', null, px, pz, 2);
    }
  }

  const baseKits = {} as Record<KitName, Float32Array>;
  const kits = {} as Record<KitName, Float32Array>;
  for (const k of KIT_NAMES) {
    baseKits[k] = new Float32Array(e.kits[k]);
    kits[k] = baseKits[k].slice();
  }
  const baseShadows = new Float32Array(e.shadows);
  return { lots, items: e.items, baseKits, baseShadows, kits, shadows: baseShadows.slice() };
}

/**
 * Items inside the construction zone that the roads of `net` run over (to be demolished).
 * Lots are tested on a 5×5 grid of points, trees at their centre plus radius.
 */
export function itemsHitByRoads(city: City, net: RoadNetwork, zone: Zone, use: MaskPart = 'all'): number[] {
  const mask = new RoadMask(net, 0.3);
  const out: number[] = [];
  for (const it of city.items) {
    if (zoneDistance(zone, it.x, it.z) > it.r) continue;
    if (it.lot) {
      const [ax, az] = lotAxes(it.lot.angle);
      let hit = false;
      for (let i = 0; i <= 4 && !hit; i++) {
        for (let j = 0; j <= 4 && !hit; j++) {
          const u = (i / 4 - 0.5) * 2 * it.lot.hx, v = (j / 4 - 0.5) * 2 * it.lot.hz;
          hit = mask.blocked(it.lot.cx + ax[0] * u + az[0] * v, it.lot.cz + ax[1] * u + az[1] * v, -1, -1, use);
        }
      }
      if (hit) out.push(it.id);
    } else if (mask.blocked(it.x, it.z, 0.5, -1, use)) {
      out.push(it.id);
    }
  }
  return out;
}

/**
 * Rewrites the live instance buffers from the base ones: demolished items vanish, sinking items
 * (id → progress 0..1) are lowered into the ground with their shadows fading.
 */
export function applyDemolition(city: City, demolished: ReadonlySet<number>, sinking: ReadonlyMap<number, number>): void {
  for (const k of KIT_NAMES) city.kits[k].set(city.baseKits[k]);
  city.shadows.set(city.baseShadows);
  const touch = (id: number, progress: number): void => {
    const it = city.items[id];
    if (!it) return;
    for (const r of it.ranges) {
      const buf = city.kits[r.kit];
      for (let i = r.start; i < r.start + r.count; i++) {
        const o = i * LIT_STRIDE;
        if (progress >= 1) {
          buf[o + 4] = 0; buf[o + 5] = 0; buf[o + 6] = 0;
        } else {
          buf[o + 1] = buf[o + 1]! - it.top * progress * progress;
        }
      }
    }
    for (let i = it.shadow.start; i < it.shadow.start + it.shadow.count; i++) {
      const o = i * SHADOW_STRIDE + 7;
      city.shadows[o] = city.shadows[o]! * Math.max(0, 1 - progress);
    }
  };
  for (const id of demolished) touch(id, sinking.get(id) ?? 1);
}

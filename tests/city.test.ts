import { describe, expect, it } from 'vitest';
import { Rng } from '../src/core/rng';
import { LIT_STRIDE, SHADOW_STRIDE, generateCity, lotsOverlap, pointInLot } from '../src/env/city';
import { contextDistance, sdRoundRect, zoneDistance } from '../src/env/zone';
import { TEST_SEED, TEST_ZONE, buildTestNetwork } from '../src/game/testScene';
import { coneGeometry, crownGeometry, roofGeometry } from '../src/render/geometry';

describe('Rng', () => {
  it('is deterministic per seed and in [0, 1)', () => {
    const a = new Rng(42), b = new Rng(42), c = new Rng(43);
    const xs = Array.from({ length: 100 }, () => a.next());
    expect(xs).toEqual(Array.from({ length: 100 }, () => b.next()));
    expect(xs).not.toEqual(Array.from({ length: 100 }, () => c.next()));
    for (const x of xs) expect(x >= 0 && x < 1).toBe(true);
  });
});

describe('zone', () => {
  it('signed distance is negative inside, positive outside', () => {
    expect(sdRoundRect(0, 0, 10, 10, 2)).toBeCloseTo(-10);
    expect(sdRoundRect(15, 0, 10, 10, 2)).toBeCloseTo(5);
    expect(zoneDistance(TEST_ZONE, 0, 0)).toBeLessThan(0);
    expect(zoneDistance(TEST_ZONE, 100, 0)).toBeGreaterThan(0);
    expect(contextDistance(TEST_ZONE, 100, 0)).toBeLessThan(0);
  });
});

describe('lot geometry', () => {
  it('detects rotated overlaps', () => {
    const a = { cx: 0, cz: 0, hx: 5, hz: 5, angle: 0, kind: 'house' as const, inZone: false };
    expect(lotsOverlap(a, { ...a, cx: 9, angle: Math.PI / 4 })).toBe(true);
    expect(lotsOverlap(a, { ...a, cx: 13, angle: Math.PI / 4 })).toBe(false);
    expect(pointInLot({ ...a, angle: 0.7 }, 0, 4)).toBe(true);
  });
});

describe('generateCity', () => {
  const net = buildTestNetwork();
  const city = generateCity(net, TEST_ZONE, TEST_SEED);

  it('is deterministic for a seed', () => {
    const again = generateCity(net, TEST_ZONE, TEST_SEED);
    expect(again.kits.box).toEqual(city.kits.box);
    expect(again.shadows).toEqual(city.shadows);
    const other = generateCity(net, TEST_ZONE, TEST_SEED + 1);
    expect(other.kits.box).not.toEqual(city.kits.box);
  });

  it('fills the scene, inside and outside the construction area', () => {
    expect(city.lots.length).toBeGreaterThan(40);
    expect(city.lots.some((l) => l.inZone)).toBe(true);
    expect(city.lots.some((l) => !l.inZone)).toBe(true);
    expect(city.kits.crown.length / LIT_STRIDE).toBeGreaterThan(50);
    expect(city.shadows.length % SHADOW_STRIDE).toBe(0);
  });

  it('never places lots on top of each other or on roads', () => {
    for (let i = 0; i < city.lots.length; i++) {
      for (let j = i + 1; j < city.lots.length; j++) {
        expect(lotsOverlap(city.lots[i]!, city.lots[j]!)).toBe(false);
      }
    }
    // Sample every road centreline: no lot may contain it.
    for (const seg of net.segments.values()) {
      for (let k = 0; k <= 20; k++) {
        const p = seg.curve.point(k / 20);
        for (const l of city.lots) expect(pointInLot(l, p[0], p[2])).toBe(false);
      }
    }
  });
});

describe('environment meshes', () => {
  it('have outward-facing normals', () => {
    for (const [g, centre] of [[roofGeometry(), [0, 0.3, 0]], [crownGeometry(), [0, 1, 0]], [coneGeometry(), [0, 0.3, 0]]] as const) {
      const v = g.vertices;
      for (let i = 0; i < v.length; i += 18) {
        const mx = (v[i]! + v[i + 6]! + v[i + 12]!) / 3 - centre[0];
        const my = (v[i + 1]! + v[i + 7]! + v[i + 13]!) / 3 - centre[1];
        const mz = (v[i + 2]! + v[i + 8]! + v[i + 14]!) / 3 - centre[2];
        expect(mx * v[i + 3]! + my * v[i + 4]! + mz * v[i + 5]!).toBeGreaterThan(0);
      }
    }
  });
});

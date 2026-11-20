import type { CityItem } from '../env/city';
import type { RoadSegment } from '../network/network';

/** Construction prices in thousands of euros (placeholder economy until the game layer). */
const PAVE_PER_M2 = 0.12;
const DEMOLISH: Record<CityItem['kind'], number> = { house: 120, shop: 180, midrise: 650, park: 40, tree: 3 };

/** Cost (k€) of building a road from scratch. */
export function roadCost(seg: RoadSegment): number {
  const { forward, backward, laneWidth, sidewalk } = seg.profile;
  return seg.curve.length * ((forward + backward) * laneWidth + 2 * sidewalk) * PAVE_PER_M2;
}

export function demolitionCost(items: readonly CityItem[]): number {
  return items.reduce((s, it) => s + DEMOLISH[it.kind], 0);
}

export function formatMoney(k: number): string {
  return k >= 1000 ? `€${(k / 1000).toFixed(k >= 10000 ? 0 : 1)}M` : `€${Math.round(k)}k`;
}

/**
 * The construction area (where the player may build) as a rounded rectangle on the ground,
 * plus the surrounding context ring that is `contextScale` times larger and fades out.
 * Shaders mirror `sdRoundRect` (see ZONE chunk in shaders.ts); keep the two in sync.
 */
export interface Zone {
  cx: number;
  cz: number;
  hx: number; // half size along x
  hz: number; // half size along z
  radius: number; // corner radius
  contextScale: number;
}

/** Signed distance to a rounded rectangle centred at the origin (negative inside). */
export function sdRoundRect(px: number, pz: number, hx: number, hz: number, r: number): number {
  const qx = Math.abs(px) - hx + r, qz = Math.abs(pz) - hz + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qz), 0) - r;
}

/** Distance from the construction-area border (negative inside the buildable area). */
export function zoneDistance(z: Zone, x: number, zz: number): number {
  return sdRoundRect(x - z.cx, zz - z.cz, z.hx, z.hz, z.radius);
}

/** Distance from the outer edge of the context ring (negative inside the visible city). */
export function contextDistance(z: Zone, x: number, zz: number): number {
  const s = z.contextScale;
  return sdRoundRect(x - z.cx, zz - z.cz, z.hx * s, z.hz * s, z.radius * s);
}

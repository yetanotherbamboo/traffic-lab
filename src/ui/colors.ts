import type { Vec3 } from '../core/math';

/** Editor colours, shared by the HTML panels (hex) and the 3D overlay (linear-ish RGB). */
export const APPROACH_HEX = ['#7cc6fe', '#ffb86b', '#b8e986', '#d6a2e8', '#ffd86b', '#f78fb3'];
export const FORWARD_HEX = '#7cc6fe';
export const BACKWARD_HEX = '#ffb86b';

export function hexToVec(hex: string): Vec3 {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export const OVERLAY = {
  ok: hexToVec('#8fd3b6'),
  error: hexToVec('#ff7a6b'),
  node: hexToVec('#f6f2e8'),
  segment: hexToVec('#ffd86b'),
  free: hexToVec('#8fd3b6'),
  select: hexToVec('#7cc6fe'),
  major: hexToVec('#ffd86b'),
  demolish: hexToVec('#ff7a6b'),
  guide: hexToVec('#7cc6fe'),
};

import { type Vec3, vec3 } from '../core/math';

// Single source of truth for the scene's look. Pure data, safe to import from anywhere.

export const BACKGROUND: Vec3 = [0.14, 0.145, 0.18];
export const SUN_DIR: Vec3 = vec3.normalize([0.5, 0.72, 0.42]); // warm late-afternoon sun
export const SUN_COLOR: Vec3 = [1.0, 0.9, 0.76];
export const SKY_COLOR: Vec3 = [0.84, 0.9, 1.0];
export const GROUND_BOUNCE: Vec3 = [0.62, 0.56, 0.45];

export const PALETTE = {
  walls: [
    [0.96, 0.91, 0.82], [0.96, 0.81, 0.69], [0.79, 0.86, 0.77], [0.77, 0.84, 0.92],
    [0.85, 0.81, 0.9], [0.97, 0.9, 0.67], [0.93, 0.92, 0.9], [0.95, 0.75, 0.72],
  ] as Vec3[],
  roofs: [[0.8, 0.48, 0.39], [0.47, 0.52, 0.6], [0.63, 0.46, 0.37], [0.44, 0.6, 0.6]] as Vec3[],
  leaves: [[0.47, 0.66, 0.42], [0.55, 0.72, 0.45], [0.39, 0.58, 0.41], [0.6, 0.7, 0.4]] as Vec3[],
  autumn: [[0.88, 0.63, 0.35], [0.86, 0.5, 0.36]] as Vec3[],
  trunk: [0.48, 0.37, 0.29] as Vec3,
  grass: [0.6, 0.77, 0.5] as Vec3,
  roofUnit: [0.72, 0.72, 0.74] as Vec3,
};

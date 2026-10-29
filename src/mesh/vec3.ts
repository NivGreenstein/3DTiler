import type { Vec3 } from '@src/tiling/enu';

const XYZ = 3;
const X = 0 as const;
const Y = 1 as const;
// eslint-disable-next-line @typescript-eslint/no-magic-numbers -- the z axis index
const Z = 2 as const;

/**
 * Reads the x, y, z triplet that starts at the offset of a flat array.
 */
const readVec3 = (values: ArrayLike<number>, offset: number): Vec3 => [
  values[offset + X] as number,
  values[offset + Y] as number,
  values[offset + Z] as number,
];

/**
 * Reads the vertex at the index of a flat x, y, z array.
 */
const readVertex = (values: ArrayLike<number>, index: number): Vec3 => readVec3(values, index * XYZ);

const subtract = (a: Vec3, b: Vec3): Vec3 => [a[X] - b[X], a[Y] - b[Y], a[Z] - b[Z]];

const cross = (a: Vec3, b: Vec3): Vec3 => [a[Y] * b[Z] - a[Z] * b[Y], a[Z] * b[X] - a[X] * b[Z], a[X] * b[Y] - a[Y] * b[X]];

const dot = (a: Vec3, b: Vec3): number => a[X] * b[X] + a[Y] * b[Y] + a[Z] * b[Z];

export { XYZ, X, Y, Z, readVec3, readVertex, subtract, cross, dot };

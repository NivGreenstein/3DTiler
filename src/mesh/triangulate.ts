import earcut from 'earcut';
import type { Vec3 } from '@src/tiling/enu';
import { X, XYZ, Y, Z, cross, dot, readVec3, readVertex, subtract } from './vec3';

const DIMENSIONS_2D = 2;
const MIN_NORMAL_LENGTH = 1e-12;

/**
 * A planar face triangulated into triangles over its own vertices.
 */
interface TriangulatedFace {
  /**
   * The face vertices, as x, y, z triplets.
   */
  vertices: number[];
  /**
   * Triangles as triplets of vertex indices, counter clockwise when seen from the normal side.
   */
  indices: number[];
  normal: Vec3;
}

/**
 * Computes the unit normal of a ring with Newell's method, it points to the side the ring is counter clockwise from.
 * Returns undefined for a degenerate ring.
 */
const computeNewellNormal = (ring: readonly number[]): Vec3 | undefined => {
  let nx = 0;
  let ny = 0;
  let nz = 0;
  const count = ring.length / XYZ;
  for (let i = 0; i < count; i++) {
    const [x1, y1, z1] = readVertex(ring, i);
    const [x2, y2, z2] = readVertex(ring, (i + 1) % count);
    nx += (y1 - y2) * (z1 + z2);
    ny += (z1 - z2) * (x1 + x2);
    nz += (x1 - x2) * (y1 + y2);
  }

  const length = Math.hypot(nx, ny, nz);
  if (length < MIN_NORMAL_LENGTH) {
    return undefined;
  }
  return [nx / length, ny / length, nz / length];
};

const computeTriangleNormal = (vertices: readonly number[], a: number, b: number, c: number): Vec3 => {
  const origin = readVertex(vertices, a);
  return cross(subtract(readVertex(vertices, b), origin), subtract(readVertex(vertices, c), origin));
};

/**
 * Triangulates a planar 3D polygon (outer ring and holes, already in a metric frame such as ENU).
 * The polygon is projected on the plane of its largest normal component and triangulated with earcut, and every triangle is
 * wound like the outer ring. Returns undefined for a degenerate face.
 */
const triangulateFace = (rings: readonly (readonly number[])[]): TriangulatedFace | undefined => {
  const outer = rings[0];
  if (outer === undefined || outer.length < XYZ * XYZ) {
    return undefined;
  }

  const normal = computeNewellNormal(outer);
  if (normal === undefined) {
    return undefined;
  }

  // the two axes that stay after dropping the axis of the largest normal component
  const [absX, absY, absZ] = normal.map(Math.abs) as Vec3;
  const [u, v] = absZ >= absX && absZ >= absY ? [X, Y] : absX >= absY ? [Y, Z] : [Z, X];

  const vertices: number[] = [];
  const flat: number[] = [];
  const holeIndices: number[] = [];
  rings.forEach((ring, ringIndex) => {
    if (ringIndex > 0) {
      holeIndices.push(vertices.length / XYZ);
    }
    for (let i = 0; i < ring.length; i += XYZ) {
      const vertex = readVec3(ring, i);
      vertices.push(...vertex);
      flat.push(vertex[u], vertex[v]);
    }
  });

  const triangles = earcut(flat, holeIndices, DIMENSIONS_2D);
  const indices: number[] = [];
  for (let i = 0; i < triangles.length; i += XYZ) {
    const [a, b, c] = readVec3(triangles, i);
    if (dot(computeTriangleNormal(vertices, a, b, c), normal) >= 0) {
      indices.push(a, b, c);
    } else {
      indices.push(a, c, b);
    }
  }

  if (indices.length === 0) {
    return undefined;
  }
  return { vertices, indices, normal };
};

export { computeNewellNormal, triangulateFace };
export type { TriangulatedFace };

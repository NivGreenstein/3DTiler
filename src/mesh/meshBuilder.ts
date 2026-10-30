import type { Vec3 } from '@src/tiling/enu';
import { XYZ, readVec3 } from './vec3';

/**
 * The mesh of one content tile, in the ENU frame of the tile. Every face has its own vertices so normals are flat.
 */
interface TileMesh {
  positions: Float32Array;
  normals: Float32Array;
  featureIds: Float32Array;
  /**
   * The face label of every vertex, used for coloring.
   */
  labels: Uint8Array;
  indices: Uint32Array;
  min: Vec3;
  max: Vec3;
  vertexCount: number;
  triangleCount: number;
}

class MeshBuilder {
  private readonly positions: number[] = [];
  private readonly normals: number[] = [];
  private readonly featureIds: number[] = [];
  private readonly labels: number[] = [];
  private readonly indices: number[] = [];

  public get isEmpty(): boolean {
    return this.indices.length === 0;
  }

  /**
   * Adds a flat face.
   *
   * @param featureId - The feature (property table row) of the face
   * @param label - The face label
   * @param vertices - Vertices as x, y, z triplets in the tile ENU frame
   * @param indices - Triangles as triplets of indices into vertices
   * @param normal - The unit normal of the face
   */
  public addFace(featureId: number, label: number, vertices: readonly number[], indices: readonly number[], normal: Vec3): void {
    const base = this.positions.length / XYZ;
    for (let i = 0; i < vertices.length; i += XYZ) {
      this.positions.push(...readVec3(vertices, i));
      this.normals.push(...normal);
      this.featureIds.push(featureId);
      this.labels.push(label);
    }
    for (const index of indices) {
      this.indices.push(base + index);
    }
  }

  public build(): TileMesh {
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    const positions = Float32Array.from(this.positions);
    // min and max must be computed on the float32 values so they bound what is stored
    for (let i = 0; i < positions.length; i += XYZ) {
      for (let axis = 0; axis < XYZ; axis++) {
        const value = positions[i + axis] as number;
        min[axis] = Math.min(min[axis] as number, value);
        max[axis] = Math.max(max[axis] as number, value);
      }
    }

    return {
      positions,
      normals: Float32Array.from(this.normals),
      featureIds: Float32Array.from(this.featureIds),
      labels: Uint8Array.from(this.labels),
      indices: Uint32Array.from(this.indices),
      min,
      max,
      vertexCount: positions.length / XYZ,
      triangleCount: this.indices.length / XYZ,
    };
  }
}

export { MeshBuilder };
export type { TileMesh };

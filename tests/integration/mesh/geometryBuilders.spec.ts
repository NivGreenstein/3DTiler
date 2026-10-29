import type { DataSource } from 'typeorm';
import { jsLogger, type Logger } from '@map-colonies/js-logger';
import { describe, beforeAll, afterAll, it, expect } from 'vitest';
import { NodeGeometryBuilder } from '@src/mesh/geometryBuilder/nodeGeometryBuilder';
import { PostgisGeometryBuilder } from '@src/mesh/geometryBuilder/postgisGeometryBuilder';
import { getTileFrame } from '@src/mesh/geometryBuilder/tileFrame';
import type { TileContent } from '@src/mesh/geometryBuilder/interfaces';
import type { GridTile } from '@src/tiling/grid';
import { BOX_LABELS, boxFaces, createTestDataSource, createTestRepository, dropTestDataSource, insertBuilding, type Point3 } from '../helpers/db';

const SCHEMA = 'tiler_geometry_integration';
const MILLIMETER = 0.001;
const XYZ = 3;

type Vec = [number, number, number];

interface MeshTriangle {
  featureId: number;
  label: number;
  points: [Vec, Vec, Vec];
}

const vertexAt = (positions: Float32Array, index: number): Vec => [
  positions[index * XYZ] as number,
  positions[index * XYZ + 1] as number,
  positions[index * XYZ + 2] as number,
];

const getTriangles = (content: TileContent): MeshTriangle[] => {
  const { positions, indices, featureIds, labels } = content.mesh;
  const result: MeshTriangle[] = [];
  for (let i = 0; i < indices.length; i += XYZ) {
    const [a, b, c] = [indices[i] as number, indices[i + 1] as number, indices[i + 2] as number];
    result.push({
      featureId: featureIds[a] as number,
      label: labels[a] as number,
      points: [vertexAt(positions, a), vertexAt(positions, b), vertexAt(positions, c)],
    });
  }
  return result;
};

const cross = (a: Vec, b: Vec, c: Vec): Vec => {
  const [ux, uy, uz] = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const [vx, vy, vz] = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
};

// the area weighted normal (half the sum of the triangle cross products) per feature and label
const getAreaVectors = (content: TileContent): Map<string, Vec> => {
  const sums = new Map<string, Vec>();
  for (const { featureId, label, points } of getTriangles(content)) {
    const key = `${featureId}:${label}`;
    const [x, y, z] = cross(...points);
    const sum = sums.get(key) ?? [0, 0, 0];
    sums.set(key, [sum[0] + x / 2, sum[1] + y / 2, sum[2] + z / 2]);
  }
  return sums;
};

const nearestDistance = (point: Vec, positions: Float32Array): number => {
  let nearest = Infinity;
  for (let j = 0; j < positions.length / XYZ; j++) {
    const [x, y, z] = vertexAt(positions, j);
    nearest = Math.min(nearest, Math.hypot(point[0] - x, point[1] - y, point[2] - z));
  }
  return nearest;
};

describe('geometry builders', () => {
  let dataSource: DataSource;
  let tile: GridTile;
  let logger: Logger;

  beforeAll(async () => {
    logger = await jsLogger({ enabled: false });
    dataSource = await createTestDataSource(SCHEMA);
    await dataSource.query('CREATE EXTENSION IF NOT EXISTS postgis_sfcgal');

    const [lon, lat, ground, eaves, ridge, size] = [5.838, 50.858, 120, 126, 131, 0.0002];
    const [w, s, e, n, mid] = [lon, lat, lon + size, lat + size, lat + size / 2];
    const inset = size * 0.4;
    // a house with a gable roof (two sloped faces) and a courtyard hole in its ground face, every face wound outwards
    const courtyard: Point3[] = [
      [w + inset, s + inset, ground],
      [e - inset, s + inset, ground],
      [e - inset, n - inset, ground],
      [w + inset, n - inset, ground],
    ];
    const house: Point3[][][] = [
      [
        [
          [w, s, ground],
          [w, n, ground],
          [e, n, ground],
          [e, s, ground],
        ],
        courtyard,
      ],
      [
        [
          [w, s, eaves],
          [e, s, eaves],
          [e, mid, ridge],
          [w, mid, ridge],
        ],
      ],
      [
        [
          [w, mid, ridge],
          [e, mid, ridge],
          [e, n, eaves],
          [w, n, eaves],
        ],
      ],
      [
        [
          [w, s, ground],
          [e, s, ground],
          [e, s, eaves],
          [w, s, eaves],
        ],
      ],
      [
        [
          [e, s, ground],
          [e, n, ground],
          [e, n, eaves],
          [e, mid, ridge],
          [e, s, eaves],
        ],
      ],
      [
        [
          [e, n, ground],
          [w, n, ground],
          [w, n, eaves],
          [e, n, eaves],
        ],
      ],
      [
        [
          [w, n, ground],
          [w, s, ground],
          [w, s, eaves],
          [w, mid, ridge],
          [w, n, eaves],
        ],
      ],
    ];
    tile = await insertBuilding(dataSource, SCHEMA, {
      id: 'house',
      lon,
      lat,
      z: 15,
      height: ridge - ground,
      faces: house,
      labels: [0, 1, 1, 2, 2, 2, 2],
    });
    const boxLon = lon + 0.0004;
    const box = boxFaces(boxLon, lat, ground, ground + 10);
    // a degenerate face with a repeated vertex, as found in 3DBAG, that SFCGAL rejects and earcut drops
    const [a, b] = box[0]?.[0] as Point3[];
    box.push([[a as Point3, a as Point3, b as Point3]]);
    await insertBuilding(dataSource, SCHEMA, { id: 'box', lon: boxLon, lat, z: 15, height: 10, faces: box, labels: [...BOX_LABELS, 2] });
  });

  afterAll(async () => {
    await dropTestDataSource(dataSource, SCHEMA);
  });

  it('should build the same mesh in node and in PostGIS', async () => {
    const repository = createTestRepository(dataSource);
    const frame = getTileFrame(tile);

    const nodeContent = (await new NodeGeometryBuilder(repository).buildTile(tile, frame)) as TileContent;
    const postgisContent = (await new PostgisGeometryBuilder(repository, logger).buildTile(tile, frame)) as TileContent;

    expect(nodeContent.features).toEqual(postgisContent.features);
    expect(nodeContent.features.map((f) => f.id)).toEqual(['box', 'house']);

    // every PostGIS vertex is a node vertex, within a millimeter
    const distances = Array.from({ length: postgisContent.mesh.vertexCount }, (_, i) =>
      nearestDistance(vertexAt(postgisContent.mesh.positions, i), nodeContent.mesh.positions)
    );

    expect(Math.max(...distances)).toBeLessThan(MILLIMETER);

    // the same surface, facing the same way, per feature and label
    const nodeAreas = getAreaVectors(nodeContent);
    const postgisAreas = getAreaVectors(postgisContent);

    expect([...postgisAreas.keys()].sort()).toEqual([...nodeAreas.keys()].sort());

    const differences = [...nodeAreas].map(([key, [x, y, z]]) => {
      const [px, py, pz] = postgisAreas.get(key) as Vec;
      return Math.hypot(x - px, y - py, z - pz);
    });

    expect(Math.max(...differences)).toBeLessThan(0.01);
  });

  it('should wind roofs up and ground faces down in the ENU frame', async () => {
    const repository = createTestRepository(dataSource);
    const content = (await new NodeGeometryBuilder(repository).buildTile(tile, getTileFrame(tile))) as TileContent;
    const areas = getAreaVectors(content);

    // house is feature 1, the courtyard hole is cut out of its ground face
    const ground = areas.get('1:0') as Vec;
    const roof = areas.get('1:1') as Vec;

    expect(ground[2]).toBeLessThan(0);
    expect(roof[2]).toBeGreaterThan(0);

    // the footprint is about 14 x 22 m with a 2.8 x 4.4 m hole
    const expectedArea = 14 * 22 - 2.8 * 4.4;

    expect(Math.abs(-ground[2] - expectedArea)).toBeLessThan(20);
  });

  it('should return undefined for an empty tile', async () => {
    const repository = createTestRepository(dataSource);
    const empty = { z: 15, x: 0, y: 0 };

    await expect(new NodeGeometryBuilder(repository).buildTile(empty, getTileFrame(empty))).resolves.toBeUndefined();
    await expect(new PostgisGeometryBuilder(repository, logger).buildTile(empty, getTileFrame(empty))).resolves.toBeUndefined();
  });
});

/* eslint-disable @typescript-eslint/naming-convention */ // psql variables, environment variables and SQL column names
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import type { DataSource } from 'typeorm';
import { describe, beforeAll, afterAll, it, expect } from 'vitest';
import { NodeGeometryBuilder } from '@src/mesh/geometryBuilder/nodeGeometryBuilder';
import { getTileFrame } from '@src/mesh/geometryBuilder/tileFrame';
import type { TileContent } from '@src/mesh/geometryBuilder/interfaces';
import { cross, readVertex, subtract, XYZ } from '@src/mesh/vec3';
import type { Vec3 } from '@src/tiling/enu';
import type { GridTile } from '@src/tiling/grid';
import { createTestDataSource, createTestRepository, dropTestDataSource } from '../helpers/db';

const SCHEMA = 'tiler_footprints_integration';
const STAGING_TABLE = `${SCHEMA}.footprints_staging`;
const SQUARE_METER_TOLERANCE = 0.01;

// runs the extrusion the same way scripts/footprints/import.sh does, with its default attribute mapping
const runUpsert = (): void => {
  const variables = {
    schema: SCHEMA,
    staging_table: STAGING_TABLE,
    source: 'overture',
    id_expr: 'f.id',
    height_expr: 'coalesce(f.height, f.num_floors * 3, 9)',
    min_height_expr: 'f.min_height',
    roof_type_expr: 'f.roof_shape',
    ground_height: '0',
    large_height: '15',
    large_area: '500',
    large_level: '14',
    small_level: '15',
  };
  const args = ['-v', 'ON_ERROR_STOP=1', '-q', ...Object.entries(variables).flatMap(([name, value]) => ['-v', `${name}=${value}`])];
  execFileSync('psql', [...args, '-f', path.join(process.cwd(), 'scripts/footprints/upsert_footprints.sql')], {
    env: {
      ...process.env,
      PGHOST: process.env.DB_HOST ?? 'localhost',
      PGPORT: process.env.DB_PORT ?? '5432',
      PGUSER: process.env.DB_USERNAME ?? 'postgres',
      PGPASSWORD: process.env.DB_PASSWORD ?? 'postgres',
      PGDATABASE: process.env.DB_NAME ?? 'postgres',
    },
    stdio: 'pipe',
  });
};

// the area weighted normal of every face label of every feature
const getAreaVectors = (content: TileContent): Map<string, Vec3> => {
  const { positions, indices, featureIds, labels } = content.mesh;
  const sums = new Map<string, Vec3>();
  for (let i = 0; i < indices.length; i += XYZ) {
    const [a, b, c] = [indices[i] as number, indices[i + 1] as number, indices[i + 2] as number];
    const origin = readVertex(positions, a);
    const [x, y, z] = cross(subtract(readVertex(positions, b), origin), subtract(readVertex(positions, c), origin));
    const key = `${featureIds[a]}:${labels[a]}`;
    const sum = sums.get(key) ?? [0, 0, 0];
    sums.set(key, [sum[0] + x / 2, sum[1] + y / 2, sum[2] + z / 2]);
  }
  return sums;
};

describe('upsert_footprints.sql', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = await createTestDataSource(SCHEMA);
    await dataSource.query(
      `CREATE TABLE ${STAGING_TABLE} (id text, height double precision, num_floors integer, min_height double precision, roof_shape text, geom geometry(MultiPolygon, 4326))`
    );

    const [lon, lat, size] = [34.78, 32.07, 0.0002];
    const [w, s, e, n] = [lon, lat, lon + size, lat + size];
    const [hw, hs] = [w + size * 0.1, s + size * 0.1];
    // an L shaped footprint with a courtyard, and two boxes, wound clockwise on purpose
    const lShape = `MULTIPOLYGON(((${w} ${s},${e} ${s},${e} ${s + size / 2},${w + size / 2} ${s + size / 2},${w + size / 2} ${n},${w} ${n},${w} ${s}),(${hw} ${hs},${hw} ${hs + size * 0.05},${hw + size * 0.05} ${hs + size * 0.05},${hw + size * 0.05} ${hs},${hw} ${hs})))`;
    const box = (x: number): string =>
      `MULTIPOLYGON(((${x} ${s},${x} ${s + size / 4},${x + size / 4} ${s + size / 4},${x + size / 4} ${s},${x} ${s})))`;
    await dataSource.query(
      `INSERT INTO ${STAGING_TABLE} VALUES
        ('l-shape', 12, NULL, 2, 'flat', ST_GeomFromText($1, 4326)),
        ('floors', NULL, 4, NULL, NULL, ST_GeomFromText($2, 4326)),
        ('unknown', NULL, NULL, NULL, NULL, ST_GeomFromText($3, 4326))`,
      [lShape, box(e + size), box(e + size * 2)]
    );
    runUpsert();
  });

  afterAll(async () => {
    await dropTestDataSource(dataSource, SCHEMA);
  });

  it('should take the height from the height, then the floors, then the default', async () => {
    const rows = await dataSource.query<{ id: string; height: number; ground_height: number; source: string; roof_type: string | null }[]>(
      `SELECT id, height, ground_height, source, roof_type FROM ${SCHEMA}.buildings ORDER BY id`
    );

    expect(rows).toEqual([
      { id: 'floors', height: 12, ground_height: 0, source: 'overture', roof_type: null },
      // the building part starts at its min height
      { id: 'l-shape', height: 10, ground_height: 2, source: 'overture', roof_type: 'flat' },
      { id: 'unknown', height: 9, ground_height: 0, source: 'overture', roof_type: null },
    ]);
  });

  it('should make a ground face, a roof face and one wall per footprint edge, holes included', async () => {
    const [row] = await dataSource.query<{ faces: number; labels: number[] }[]>(
      `SELECT ST_NumGeometries(geom) AS faces, face_labels AS labels FROM ${SCHEMA}.buildings WHERE id = 'l-shape'`
    );

    // 6 outer edges and 4 courtyard edges
    expect(row?.faces).toBe(2 + 6 + 4);
    expect(row?.labels).toEqual([0, 1, ...Array<number>(10).fill(2)]);
  });

  it('should extrude every footprint into a closed solid with the roof up and the ground down', async () => {
    const [tile] = await dataSource.query<{ z: number; x: number; y: number }[]>(
      `SELECT tile_z AS z, tile_x AS x, tile_y AS y FROM ${SCHEMA}.buildings WHERE id = 'l-shape'`
    );
    const gridTile = tile as GridTile;
    const content = (await new NodeGeometryBuilder(createTestRepository(dataSource)).buildTile(gridTile, getTileFrame(gridTile))) as TileContent;
    const areas = getAreaVectors(content);

    content.features.forEach((_, featureId) => {
      const [ground, roof, walls] = [0, 1, 2].map((label) => areas.get(`${featureId}:${label}`) as Vec3);

      expect(ground?.[2]).toBeLessThan(0);
      expect(roof?.[2]).toBeGreaterThan(0);

      // a closed surface has area vectors that sum to zero
      const total = [0, 1, 2].map((axis) => (ground?.[axis] ?? 0) + (roof?.[axis] ?? 0) + (walls?.[axis] ?? 0));

      expect(Math.hypot(...total)).toBeLessThan(SQUARE_METER_TOLERANCE);
    });
  });
});

/* eslint-disable @typescript-eslint/no-magic-numbers */ // test fixtures
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DataSource } from 'typeorm';
import type { DependencyContainer } from 'tsyringe';
import { createDataSourceOptions } from '@common/db';
import { buildingRepositoryFactory, type BuildingRepository } from '@src/building/DAL/buildingRepository';
import { lonLatToGridTile, type GridTile } from '@src/tiling/grid';

type Point3 = [number, number, number];

const createTestDataSource = async (schema: string): Promise<DataSource> => {
  const dataSource = new DataSource(
    createDataSourceOptions({
      host: process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.DB_PORT ?? 5432),
      username: process.env.DB_USERNAME ?? 'postgres',
      password: process.env.DB_PASSWORD ?? 'postgres',
      database: process.env.DB_NAME ?? 'postgres',
      schema,
      ssl: { enabled: false },
    })
  );
  await dataSource.initialize();
  await dataSource.query('CREATE EXTENSION IF NOT EXISTS postgis');
  await dataSource.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);

  // the same DDL the import scripts run
  const ddl = readFileSync(path.join(process.cwd(), 'scripts/buildings.sql'), 'utf-8').replaceAll(':"schema"', schema);
  await dataSource.query(ddl);
  return dataSource;
};

const dropTestDataSource = async (dataSource: DataSource, schema: string): Promise<void> => {
  await dataSource.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await dataSource.destroy();
};

const createTestRepository = (dataSource: DataSource): BuildingRepository =>
  buildingRepositoryFactory({ resolve: () => dataSource } as unknown as DependencyContainer);

const faceWkt = (rings: Point3[][]): string =>
  `(${rings.map((ring) => `(${[...ring, ring[0] as Point3].map((p) => p.join(' ')).join(',')})`).join(',')})`;

/**
 * A box shaped building with the given size in degrees, as faces in EPSG:4326 with ellipsoidal heights, wound outwards.
 */
const boxFaces = (lon: number, lat: number, ground: number, top: number, size = 0.0001): Point3[][][] => {
  const [w, s, e, n] = [lon, lat, lon + size, lat + size];
  return [
    [
      [
        [w, s, ground],
        [w, n, ground],
        [e, n, ground],
        [e, s, ground],
      ],
    ],
    [
      [
        [w, s, top],
        [e, s, top],
        [e, n, top],
        [w, n, top],
      ],
    ],
    [
      [
        [w, s, ground],
        [e, s, ground],
        [e, s, top],
        [w, s, top],
      ],
    ],
    [
      [
        [e, s, ground],
        [e, n, ground],
        [e, n, top],
        [e, s, top],
      ],
    ],
    [
      [
        [e, n, ground],
        [w, n, ground],
        [w, n, top],
        [e, n, top],
      ],
    ],
    [
      [
        [w, n, ground],
        [w, s, ground],
        [w, s, top],
        [w, n, top],
      ],
    ],
  ];
};

const BOX_LABELS = [0, 1, 2, 2, 2, 2];

const multiPolygonWkt = (faces: Point3[][][]): string => `MULTIPOLYGON Z (${faces.map(faceWkt).join(',')})`;

interface FixtureBuilding {
  id: string;
  lon: number;
  lat: number;
  z: number;
  faces: Point3[][][];
  labels: number[];
  height: number;
}

const insertBuilding = async (dataSource: DataSource, schema: string, building: FixtureBuilding): Promise<GridTile> => {
  const tile = lonLatToGridTile(building.lon, building.lat, building.z);
  await dataSource.query(
    `INSERT INTO ${schema}.buildings (id, building_id, source, geom, face_labels, ground_height, height, footprint_area, construction_year, roof_type, tile_z, tile_x, tile_y)
     VALUES ($1, $1, '3dbag', ST_GeomFromText($2, 4326), $3, 100, $4, 80, 1930, 'slanted', $5, $6, $7)`,
    [building.id, multiPolygonWkt(building.faces), building.labels, building.height, tile.z, tile.x, tile.y]
  );
  return tile;
};

export { createTestDataSource, dropTestDataSource, createTestRepository, boxFaces, insertBuilding, BOX_LABELS };
export type { Point3, FixtureBuilding };

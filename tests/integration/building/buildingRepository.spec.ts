import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DataSource } from 'typeorm';
import { describe, beforeAll, afterAll, it, expect } from 'vitest';
import type { DependencyContainer } from 'tsyringe';
import { createDataSourceOptions } from '@common/db';
import { buildingRepositoryFactory, type BuildingRepository } from '@src/building/DAL/buildingRepository';
import { getMetatileContentRanges, lonLatToGridTile } from '@src/tiling/grid';

const SCHEMA = 'tiler_integration';
const CONTENT_LEVELS = [14, 15];

// a box shaped building of the given size in degrees, as faces in EPSG:4979
const boxWkt = (lon: number, lat: number, ground: number, top: number, size = 0.0001): string => {
  const [w, s, e, n] = [lon, lat, lon + size, lat + size];
  const face = (points: number[][]): string => `((${[...points, points[0] as number[]].map((p) => p.join(' ')).join(',')}))`;
  const faces = [
    face([
      [w, s, ground],
      [w, n, ground],
      [e, n, ground],
      [e, s, ground],
    ]),
    face([
      [w, s, top],
      [e, s, top],
      [e, n, top],
      [w, n, top],
    ]),
    face([
      [w, s, ground],
      [e, s, ground],
      [e, s, top],
      [w, s, top],
    ]),
    face([
      [e, s, ground],
      [e, n, ground],
      [e, n, top],
      [e, s, top],
    ]),
    face([
      [e, n, ground],
      [w, n, ground],
      [w, n, top],
      [e, n, top],
    ]),
    face([
      [w, n, ground],
      [w, s, ground],
      [w, s, top],
      [w, n, top],
    ]),
  ];
  return `MULTIPOLYGON Z (${faces.join(',')})`;
};

describe('BuildingRepository', () => {
  let dataSource: DataSource;
  let repository: BuildingRepository;

  beforeAll(async () => {
    dataSource = new DataSource(
      createDataSourceOptions({
        host: process.env.DB_HOST ?? 'localhost',
        port: Number(process.env.DB_PORT ?? 5432),
        username: process.env.DB_USERNAME ?? 'postgres',
        password: process.env.DB_PASSWORD ?? 'postgres',
        database: process.env.DB_NAME ?? 'postgres',
        schema: SCHEMA,
        ssl: { enabled: false },
      })
    );
    await dataSource.initialize();
    await dataSource.query('CREATE EXTENSION IF NOT EXISTS postgis');
    await dataSource.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);

    // the same DDL the import scripts run
    const ddl = readFileSync(path.join(process.cwd(), 'scripts/3dbag/buildings.sql'), 'utf-8').replaceAll(':"schema"', SCHEMA);
    await dataSource.query(ddl);

    const insert = async (id: string, lon: number, lat: number, z: number, height: number): Promise<void> => {
      const tile = lonLatToGridTile(lon, lat, z);
      await dataSource.query(
        `INSERT INTO ${SCHEMA}.buildings (id, building_id, source, geom, face_labels, ground_height, height, footprint_area, construction_year, roof_type, tile_z, tile_x, tile_y)
         VALUES ($1, $1, '3dbag', ST_GeomFromText($2, 4979), '{0,1,2,2,2,2}', 100, $3, 80, 1930, 'slanted', $4, $5, $6)`,
        [id, boxWkt(lon, lat, 100, 100 + height), height, tile.z, tile.x, tile.y]
      );
    };

    // Valkenburg, the area of 3DBAG tile 8-688-40
    await insert('small-a', 5.8373, 50.8588, 15, 10);
    await insert('small-b', 5.8401, 50.8571, 15, 8);
    await insert('tall', 5.838, 50.858, 14, 30);
    // far away, in another metatile
    await insert('far', 4.36, 52.01, 15, 10);

    repository = buildingRepositoryFactory({ resolve: () => dataSource } as unknown as DependencyContainer);
  });

  afterAll(async () => {
    await dataSource.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await dataSource.destroy();
  });

  describe('#findByTileRanges', () => {
    it('should return the buildings of every content level of the metatile and nothing outside it', async () => {
      // a z16 job with a metatile of 8 covers one z13 tile, as produced by metatile-queue-populator
      const area = lonLatToGridTile(5.8373, 50.8588, 13);
      const ranges = getMetatileContentRanges({ z: 16, x: area.x, y: area.y, metatile: 8 }, CONTENT_LEVELS);

      const buildings = await repository.findByTileRanges(ranges);

      expect(buildings.map((b) => b.id).sort()).toEqual(['small-a', 'small-b', 'tall']);
    });

    it('should map the row into a building record with its geometry as WKB', async () => {
      const tile = lonLatToGridTile(5.838, 50.858, 14);

      const [building] = await repository.findByTileRanges([{ z: 14, minX: tile.x, maxX: tile.x, minY: tile.y, maxY: tile.y }]);

      expect(building).toMatchObject({
        id: 'tall',
        buildingId: 'tall',
        source: '3dbag',
        faceLabels: [0, 1, 2, 2, 2, 2],
        groundHeight: 100,
        height: 30,
        footprintArea: 80,
        constructionYear: 1930,
        roofType: 'slanted',
        tile,
      });
      expect(Buffer.isBuffer(building?.wkb)).toBe(true);
      // little endian MultiPolygon Z
      expect(building?.wkb.readUInt32LE(1)).toBe(1006);
    });

    it('should return nothing for no ranges', async () => {
      await expect(repository.findByTileRanges([])).resolves.toEqual([]);
    });
  });
});

import type { DataSource } from 'typeorm';
import { describe, beforeAll, afterAll, it, expect } from 'vitest';
import type { BuildingRepository } from '@src/building/DAL/buildingRepository';
import { getMetatileContentRanges, lonLatToGridTile } from '@src/tiling/grid';
import { BOX_LABELS, boxFaces, createTestDataSource, createTestRepository, dropTestDataSource, insertBuilding } from '../helpers/db';

const SCHEMA = 'tiler_repository_integration';
const CONTENT_LEVELS = [14, 15];

describe('BuildingRepository', () => {
  let dataSource: DataSource;
  let repository: BuildingRepository;

  beforeAll(async () => {
    dataSource = await createTestDataSource(SCHEMA);
    const insert = async (id: string, lon: number, lat: number, z: number, height: number): Promise<void> => {
      await insertBuilding(dataSource, SCHEMA, { id, lon, lat, z, height, faces: boxFaces(lon, lat, 100, 100 + height), labels: BOX_LABELS });
    };

    // Valkenburg, the area of 3DBAG tile 8-688-40
    await insert('small-a', 5.8373, 50.8588, 15, 10);
    await insert('small-b', 5.8401, 50.8571, 15, 8);
    await insert('tall', 5.838, 50.858, 14, 30);
    // far away, in another metatile
    await insert('far', 4.36, 52.01, 15, 10);

    repository = createTestRepository(dataSource);
  });

  afterAll(async () => {
    await dropTestDataSource(dataSource, SCHEMA);
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

    it('should not read the geometry when not asked to', async () => {
      const tile = lonLatToGridTile(5.838, 50.858, 14);

      const [building] = await repository.findByTileRanges([{ z: 14, minX: tile.x, maxX: tile.x, minY: tile.y, maxY: tile.y }], {
        withGeometry: false,
      });

      expect(building?.id).toBe('tall');
      expect(building?.wkb).toHaveLength(0);
    });

    it('should return nothing for no ranges', async () => {
      await expect(repository.findByTileRanges([])).resolves.toEqual([]);
    });
  });

  describe('#findTesselatedFaces', () => {
    it('should return every face of the tile buildings as a TIN, in order', async () => {
      await dataSource.query('CREATE EXTENSION IF NOT EXISTS postgis_sfcgal');
      const tile = lonLatToGridTile(5.838, 50.858, 14);

      const faces = await repository.findTesselatedFaces(tile, '+proj=noop');

      expect(faces.map((f) => [f.id, f.faceIndex])).toEqual(BOX_LABELS.map((_, i) => ['tall', i]));
      // little endian TIN Z
      expect(faces[0]?.wkb?.readUInt32LE(1)).toBe(1016);
    });
  });
});

import { Brackets, type DataSource } from 'typeorm';
import type { FactoryFunction } from 'tsyringe';
import { DATA_SOURCE_PROVIDER } from '@common/db';
import type { GridTile, TileRange } from '@src/tiling/grid';
import type { BuildingRecord, FaceLabel } from '../models/building';
import { BuildingDb } from './building';

interface FindOptions {
  /**
   * Whether to read the geometry, defaults to true
   */
  withGeometry?: boolean;
}

/**
 * One face of a building, tesselated into a TIN and transformed by PostGIS.
 */
interface TesselatedFace {
  id: string;
  /**
   * The index of the face in the building geometry, from 0
   */
  faceIndex: number;
  /**
   * The TIN, null when SFCGAL could not tesselate the face
   */
  wkb: Buffer | null;
}

interface SourceExtent {
  source: string;
  count: number;
  west: number;
  south: number;
  east: number;
  north: number;
}

interface BuildingRow {
  id: string;
  buildingId: string;
  source: string;
  wkb?: Buffer;
  faceLabels: FaceLabel[] | null;
  groundHeight: number;
  height: number;
  footprintArea: number | null;
  constructionYear: number | null;
  roofType: string | null;
  tileZ: number;
  tileX: number;
  tileY: number;
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
const createBuildingRepository = (dataSource: DataSource) => {
  let tesselateFunction: Promise<string> | undefined;

  const getTesselateFunction = async (): Promise<string> => {
    // SFCGAL functions are named CG_* from PostGIS 3.5, and ST_* before
    tesselateFunction ??= dataSource
      .query<{ cg: boolean; st: boolean }[]>(`SELECT to_regproc('cg_tesselate') IS NOT NULL AS cg, to_regproc('st_tesselate') IS NOT NULL AS st`)
      .then(([result]) => {
        if (result?.cg === true) {
          return 'CG_Tesselate';
        }
        if (result?.st === true) {
          return 'ST_Tesselate';
        }
        throw new Error('the postgis geometry builder requires the postgis_sfcgal extension');
      });
    tesselateFunction.catch(() => {
      tesselateFunction = undefined;
    });
    return tesselateFunction;
  };

  return dataSource.getRepository(BuildingDb).extend({
    /**
     * Returns the buildings whose content tile is inside one of the given tile ranges.
     *
     * @param ranges - Inclusive tile ranges, usually one per content level of a metatile
     * @param options - Find options
     * @returns The buildings, ordered by content tile and id. Without the geometry the wkb is empty.
     */
    async findByTileRanges(ranges: TileRange[], options: FindOptions = {}): Promise<BuildingRecord[]> {
      if (ranges.length === 0) {
        return [];
      }

      const query = this.createQueryBuilder('building')
        .select('building.id', 'id')
        .addSelect('building.building_id', 'buildingId')
        .addSelect('building.source', 'source')
        .addSelect('building.face_labels', 'faceLabels')
        .addSelect('building.ground_height', 'groundHeight')
        .addSelect('building.height', 'height')
        .addSelect('building.footprint_area', 'footprintArea')
        .addSelect('building.construction_year', 'constructionYear')
        .addSelect('building.roof_type', 'roofType')
        .addSelect('building.tile_z', 'tileZ')
        .addSelect('building.tile_x', 'tileX')
        .addSelect('building.tile_y', 'tileY');

      if (options.withGeometry !== false) {
        query.addSelect('ST_AsBinary(building.geom)', 'wkb');
      }

      query
        .where(
          new Brackets((qb) => {
            ranges.forEach((range, i) => {
              qb.orWhere(
                `(building.tile_z = :z${i} AND building.tile_x BETWEEN :minX${i} AND :maxX${i} AND building.tile_y BETWEEN :minY${i} AND :maxY${i})`,
                { [`z${i}`]: range.z, [`minX${i}`]: range.minX, [`maxX${i}`]: range.maxX, [`minY${i}`]: range.minY, [`maxY${i}`]: range.maxY }
              );
            });
          })
        )
        .orderBy('building.tile_z')
        .addOrderBy('building.tile_x')
        .addOrderBy('building.tile_y')
        .addOrderBy('building.id');

      const rows = await query.getRawMany<BuildingRow>();

      return rows.map(({ tileZ, tileX, tileY, wkb, ...building }) => ({
        ...building,
        wkb: wkb ?? Buffer.alloc(0),
        tile: { z: tileZ, x: tileX, y: tileY },
      }));
    },

    /**
     * Returns the extent and the number of buildings of every source.
     */
    async findSourceExtents(): Promise<SourceExtent[]> {
      const rows = await this.createQueryBuilder('building')
        .select('building.source', 'source')
        .addSelect('count(*)::integer', 'count')
        .addSelect('ST_XMin(ST_Extent(building.geom))', 'west')
        .addSelect('ST_YMin(ST_Extent(building.geom))', 'south')
        .addSelect('ST_XMax(ST_Extent(building.geom))', 'east')
        .addSelect('ST_YMax(ST_Extent(building.geom))', 'north')
        .groupBy('building.source')
        .orderBy('count', 'DESC')
        .getRawMany<SourceExtent>();

      return rows;
    },

    /**
     * Returns the distinct tiles at the target level that have content at the content level inside the range.
     *
     * @param range - An inclusive range of tiles at the content level
     * @param targetLevel - The level of the returned tiles, at or above the content level
     * @returns The tiles at the target level
     */
    async findDistinctTiles(range: TileRange, targetLevel: number): Promise<GridTile[]> {
      const shift = range.z - targetLevel;
      if (shift < 0) {
        throw new RangeError(`target level ${targetLevel} is below the content level ${range.z}`);
      }

      const rows = await this.createQueryBuilder('building')
        .select(`building.tile_x >> ${shift}`, 'x')
        .addSelect(`building.tile_y >> ${shift}`, 'y')
        .distinct(true)
        .where('building.tile_z = :z AND building.tile_x BETWEEN :minX AND :maxX AND building.tile_y BETWEEN :minY AND :maxY', range)
        .getRawMany<{ x: number; y: number }>();

      return rows.map(({ x, y }) => ({ z: targetLevel, x, y }));
    },

    /**
     * Returns every face of every building in the content tile, tesselated by SFCGAL and transformed with the given PROJ pipeline.
     *
     * @param tile - The content tile
     * @param pipeline - A PROJ pipeline from EPSG:4326 into the tile frame
     * @returns The faces, ordered by building id and face index, faces SFCGAL rejected have no wkb
     */
    async findTesselatedFaces(tile: GridTile, pipeline: string): Promise<TesselatedFace[]> {
      const tesselate = await getTesselateFunction();

      const { driver } = this.manager.connection;
      const table =
        this.metadata.schema !== undefined
          ? `${driver.escape(this.metadata.schema)}.${driver.escape(this.metadata.tableName)}`
          : driver.escape(this.metadata.tableName);

      // SFCGAL throws on invalid faces (e.g. a repeated vertex), which would fail the whole tile. A session temporary function returns
      // NULL for those faces instead, it needs no privileges beyond the default TEMP one.
      const queryRunner = dataSource.createQueryRunner();
      await queryRunner.connect();
      try {
        await queryRunner.query(
          `CREATE OR REPLACE FUNCTION pg_temp.tiler_tesselate(face geometry) RETURNS geometry LANGUAGE plpgsql IMMUTABLE AS $$
           BEGIN
             RETURN ${tesselate}(face);
           EXCEPTION WHEN OTHERS THEN
             RETURN NULL;
           END
           $$`
        );

        return (await queryRunner.query(
          `SELECT building.id AS "id", face.path[1] - 1 AS "faceIndex", ST_AsBinary(ST_TransformPipeline(tin.geom, $4, 0)) AS "wkb"
           FROM ${table} AS building, LATERAL ST_Dump(building.geom) AS face, LATERAL (SELECT pg_temp.tiler_tesselate(face.geom) AS geom) AS tin
           WHERE building.tile_z = $1 AND building.tile_x = $2 AND building.tile_y = $3
           ORDER BY building.id, face.path[1]`,
          [tile.z, tile.x, tile.y, pipeline]
        )) as TesselatedFace[];
      } finally {
        await queryRunner.release();
      }
    },
  });
};

export type BuildingRepository = ReturnType<typeof createBuildingRepository>;
export type { TesselatedFace, FindOptions, SourceExtent };

export const buildingRepositoryFactory: FactoryFunction<BuildingRepository> = (depContainer) => {
  return createBuildingRepository(depContainer.resolve<DataSource>(DATA_SOURCE_PROVIDER));
};

export const BUILDING_CUSTOM_REPOSITORY_SYMBOL = Symbol('BUILDING_CUSTOM_REPOSITORY_SYMBOL');

import { Brackets, type DataSource } from 'typeorm';
import type { FactoryFunction } from 'tsyringe';
import { DATA_SOURCE_PROVIDER } from '@common/db';
import type { TileRange } from '@src/tiling/grid';
import type { BuildingRecord, FaceLabel } from '../models/building';
import { BuildingDb } from './building';

interface BuildingRow {
  id: string;
  buildingId: string;
  source: string;
  wkb: Buffer;
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
  return dataSource.getRepository(BuildingDb).extend({
    /**
     * Returns the buildings whose content tile is inside one of the given tile ranges.
     *
     * @param ranges - Inclusive tile ranges, usually one per content level of a metatile
     * @returns The buildings, ordered by content tile and id
     */
    async findByTileRanges(ranges: TileRange[]): Promise<BuildingRecord[]> {
      if (ranges.length === 0) {
        return [];
      }

      const query = this.createQueryBuilder('building')
        .select('building.id', 'id')
        .addSelect('building.building_id', 'buildingId')
        .addSelect('building.source', 'source')
        .addSelect('ST_AsBinary(building.geom)', 'wkb')
        .addSelect('building.face_labels', 'faceLabels')
        .addSelect('building.ground_height', 'groundHeight')
        .addSelect('building.height', 'height')
        .addSelect('building.footprint_area', 'footprintArea')
        .addSelect('building.construction_year', 'constructionYear')
        .addSelect('building.roof_type', 'roofType')
        .addSelect('building.tile_z', 'tileZ')
        .addSelect('building.tile_x', 'tileX')
        .addSelect('building.tile_y', 'tileY')
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

      return rows.map(({ tileZ, tileX, tileY, ...building }) => ({ ...building, tile: { z: tileZ, x: tileX, y: tileY } }));
    },
  });
};

export type BuildingRepository = ReturnType<typeof createBuildingRepository>;

export const buildingRepositoryFactory: FactoryFunction<BuildingRepository> = (depContainer) => {
  return createBuildingRepository(depContainer.resolve<DataSource>(DATA_SOURCE_PROVIDER));
};

export const BUILDING_CUSTOM_REPOSITORY_SYMBOL = Symbol('BUILDING_CUSTOM_REPOSITORY_SYMBOL');

import { inject, injectable } from 'tsyringe';
import type { Logger } from '@map-colonies/js-logger';
import { SERVICES } from '@common/constants';
import { BUILDING_CUSTOM_REPOSITORY_SYMBOL, type BuildingRepository } from '@src/building/DAL/buildingRepository';
import { FaceLabel } from '@src/building/models/building';
import type { GridTile } from '@src/tiling/grid';
import { readWkbPolygons } from '../wkb';
import { computeNewellNormal } from '../triangulate';
import { MeshBuilder } from '../meshBuilder';
import type { GeometryBuilder, TileContent, TileFrame } from './interfaces';
import { toTileFeature } from './features';
import { getEnuPipeline } from './tileFrame';

const TRIANGLE_VERTEX_COUNT = 3;
const TRIANGLE_INDICES = Array.from({ length: TRIANGLE_VERTEX_COUNT }, (_, i) => i);

/**
 * Builds the tile mesh in PostGIS: SFCGAL tesselates every face and ST_TransformPipeline moves it into the tile ENU frame,
 * node only collects the triangles. Requires PostGIS 3.4+ with the postgis_sfcgal extension.
 */
@injectable()
export class PostgisGeometryBuilder implements GeometryBuilder {
  public constructor(
    @inject(BUILDING_CUSTOM_REPOSITORY_SYMBOL) private readonly repository: BuildingRepository,
    @inject(SERVICES.LOGGER) private readonly logger: Logger
  ) {}

  public async buildTile(tile: GridTile, frame: TileFrame): Promise<TileContent | undefined> {
    const buildings = await this.repository.findByTileRanges([{ z: tile.z, minX: tile.x, maxX: tile.x, minY: tile.y, maxY: tile.y }], {
      withGeometry: false,
    });
    if (buildings.length === 0) {
      return undefined;
    }

    const featureIds = new Map(buildings.map((building, index) => [building.id, index]));
    const faces = await this.repository.findTesselatedFaces(tile, getEnuPipeline(frame.enu));

    const meshBuilder = new MeshBuilder();
    let invalidFaces = 0;
    for (const face of faces) {
      const featureId = featureIds.get(face.id);
      if (face.wkb === null) {
        invalidFaces++;
        continue;
      }
      if (featureId === undefined) {
        continue;
      }

      const label = buildings[featureId]?.faceLabels?.[face.faceIndex] ?? FaceLabel.OUTER_WALL;
      for (const [triangle] of readWkbPolygons(face.wkb)) {
        const normal = triangle === undefined ? undefined : computeNewellNormal(triangle);
        if (triangle !== undefined && normal !== undefined) {
          meshBuilder.addFace(featureId, label, triangle, TRIANGLE_INDICES, normal);
        }
      }
    }

    if (invalidFaces > 0) {
      this.logger.debug({ msg: 'skipped faces that SFCGAL could not tesselate', tile, invalidFaces });
    }

    return { features: buildings.map(toTileFeature), mesh: meshBuilder.build() };
  }
}

import { inject, injectable } from 'tsyringe';
import { BUILDING_CUSTOM_REPOSITORY_SYMBOL, type BuildingRepository } from '@src/building/DAL/buildingRepository';
import { FaceLabel } from '@src/building/models/building';
import { geodeticToEnu, type EnuFrame } from '@src/tiling/enu';
import type { GridTile } from '@src/tiling/grid';
import { readWkbPolygons, type Ring } from '../wkb';
import { triangulateFace } from '../triangulate';
import { MeshBuilder } from '../meshBuilder';
import { XYZ, readVec3 } from '../vec3';
import type { GeometryBuilder, TileContent, TileFrame } from './interfaces';
import { toTileFeature } from './features';

const ringToEnu = (frame: EnuFrame, ring: Ring): number[] => {
  const enu: number[] = [];
  for (let i = 0; i < ring.length; i += XYZ) {
    enu.push(...geodeticToEnu(frame, ...readVec3(ring, i)));
  }
  return enu;
};

/**
 * Builds the tile mesh in node: the faces are read from WKB, converted to the tile ENU frame and triangulated with earcut.
 */
@injectable()
export class NodeGeometryBuilder implements GeometryBuilder {
  public constructor(@inject(BUILDING_CUSTOM_REPOSITORY_SYMBOL) private readonly repository: BuildingRepository) {}

  public async buildTile(tile: GridTile, frame: TileFrame): Promise<TileContent | undefined> {
    const buildings = await this.repository.findByTileRanges([{ z: tile.z, minX: tile.x, maxX: tile.x, minY: tile.y, maxY: tile.y }]);
    if (buildings.length === 0) {
      return undefined;
    }

    const meshBuilder = new MeshBuilder();
    buildings.forEach((building, featureId) => {
      readWkbPolygons(building.wkb).forEach((rings, faceIndex) => {
        const face = triangulateFace(rings.map((ring) => ringToEnu(frame.enu, ring)));
        if (face !== undefined) {
          const label = building.faceLabels?.[faceIndex] ?? FaceLabel.OUTER_WALL;
          meshBuilder.addFace(featureId, label, face.vertices, face.indices, face.normal);
        }
      });
    });

    return { features: buildings.map(toTileFeature), mesh: meshBuilder.build() };
  }
}

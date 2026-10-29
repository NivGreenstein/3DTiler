import type { BuildingRecord } from '@src/building/models/building';
import type { TileFeature } from './interfaces';

const toTileFeature = (building: Omit<BuildingRecord, 'wkb'>): TileFeature => ({
  id: building.id,
  buildingId: building.buildingId,
  height: building.height,
  groundHeight: building.groundHeight,
  constructionYear: building.constructionYear,
  roofType: building.roofType,
});

export { toTileFeature };

import type { GridTile } from '@src/tiling/grid';

// the CityJSON semantic surface codes 3DBAG uses
/* eslint-disable @typescript-eslint/no-magic-numbers */
export enum FaceLabel {
  GROUND = 0,
  ROOF = 1,
  OUTER_WALL = 2,
}
/* eslint-enable @typescript-eslint/no-magic-numbers */

/**
 * A building (or building part) as read for tiling, its geometry is WKB in EPSG:4979.
 */
export interface BuildingRecord {
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
  tile: GridTile;
}

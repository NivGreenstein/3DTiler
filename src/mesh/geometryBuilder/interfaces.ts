import type { EnuFrame } from '@src/tiling/enu';
import type { GridTile } from '@src/tiling/grid';
import type { TileMesh } from '../meshBuilder';

/**
 * The properties of one feature (a building part) in a content tile, the feature id is its index.
 */
interface TileFeature {
  id: string;
  buildingId: string;
  height: number;
  groundHeight: number;
  constructionYear: number | null;
  roofType: string | null;
}

interface TileContent {
  features: TileFeature[];
  mesh: TileMesh;
}

/**
 * The local frame a content tile is built in: an ENU frame at the tile center, on the ellipsoid.
 */
interface TileFrame {
  center: { lon: number; lat: number };
  enu: EnuFrame;
}

interface GeometryBuilder {
  /**
   * Builds the mesh and features of a content tile, or returns undefined when the tile has no buildings.
   */
  buildTile: (tile: GridTile, frame: TileFrame) => Promise<TileContent | undefined>;
}

export type { TileFeature, TileContent, TileFrame, GeometryBuilder };

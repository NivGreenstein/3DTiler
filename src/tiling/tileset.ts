import { toRadians } from './enu';
import type { Hemisphere } from './grid';

interface TilesetOptions {
  /**
   * The geometric error of each hemisphere root, it halves with every level.
   */
  rootGeometricError: number;
  /**
   * The minimum and maximum ellipsoidal heights of the content in meters.
   */
  minHeight: number;
  maxHeight: number;
  subtreeLevels: number;
  /**
   * The number of levels in each hemisphere quadtree, the deepest content level + 1.
   */
  availableLevels: number;
  contentUriTemplate: (hemisphere: Hemisphere) => string;
  subtreeUriTemplate: (hemisphere: Hemisphere) => string;
}

const TILESET_VERSION = '1.1';
const HEMISPHERE_WIDTH_DEGREES = 180;
const HEMISPHERE_WEST_DEGREES = [-HEMISPHERE_WIDTH_DEGREES, 0] as const;
const MIN_LAT_DEGREES = -90;
const MAX_LAT_DEGREES = 90;
const PARENT_GEOMETRIC_ERROR_FACTOR = 2;

type Region = [number, number, number, number, number, number];

interface ImplicitTilesetChild {
  boundingVolume: { region: Region };
  geometricError: number;
  refine: 'ADD';
  content: { uri: string };
  implicitTiling: {
    subdivisionScheme: 'QUADTREE';
    subtreeLevels: number;
    availableLevels: number;
    subtrees: { uri: string };
  };
}

interface RootTileset {
  asset: { version: string };
  geometricError: number;
  root: {
    boundingVolume: { region: Region };
    geometricError: number;
    refine: 'ADD';
    children: ImplicitTilesetChild[];
  };
}

const hemisphereRegion = (hemisphere: Hemisphere, minHeight: number, maxHeight: number): Region => {
  const west = HEMISPHERE_WEST_DEGREES[hemisphere];
  return [toRadians(west), toRadians(MIN_LAT_DEGREES), toRadians(west + HEMISPHERE_WIDTH_DEGREES), toRadians(MAX_LAT_DEGREES), minHeight, maxHeight];
};

/**
 * Builds the static root tileset.json: an empty root with one implicit quadtree child per hemisphere.
 */
const buildRootTileset = (options: TilesetOptions): RootTileset => {
  const hemispheres: Hemisphere[] = [0, 1];
  const rootGeometricError = options.rootGeometricError * PARENT_GEOMETRIC_ERROR_FACTOR;

  return {
    asset: { version: TILESET_VERSION },
    geometricError: rootGeometricError,
    root: {
      boundingVolume: {
        region: [
          toRadians(-HEMISPHERE_WIDTH_DEGREES),
          toRadians(MIN_LAT_DEGREES),
          toRadians(HEMISPHERE_WIDTH_DEGREES),
          toRadians(MAX_LAT_DEGREES),
          options.minHeight,
          options.maxHeight,
        ],
      },
      geometricError: rootGeometricError,
      refine: 'ADD',
      children: hemispheres.map((hemisphere) => ({
        boundingVolume: { region: hemisphereRegion(hemisphere, options.minHeight, options.maxHeight) },
        geometricError: options.rootGeometricError,
        refine: 'ADD',
        content: { uri: options.contentUriTemplate(hemisphere) },
        implicitTiling: {
          subdivisionScheme: 'QUADTREE',
          subtreeLevels: options.subtreeLevels,
          availableLevels: options.availableLevels,
          subtrees: { uri: options.subtreeUriTemplate(hemisphere) },
        },
      })),
    },
  };
};

export { buildRootTileset };
export type { TilesetOptions, RootTileset };

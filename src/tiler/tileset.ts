import type { TilingConfig } from '@common/configSchema';
import { buildRootTileset } from '@src/tiling/tileset';
import { TILESET_KEY, contentUriTemplate, subtreeUriTemplate } from '@src/tiling/layout';
import type { ImplicitTile } from '@src/tiling/grid';
import type { TilesStorage } from './tilesStorage/interfaces';

const JSON_CONTENT_TYPE = 'application/json';
const JSON_INDENT = 2;

const HEMISPHERE_ROOTS: ImplicitTile[] = [
  { hemisphere: 0, level: 0, x: 0, y: 0 },
  { hemisphere: 1, level: 0, x: 0, y: 0 },
];

/**
 * Writes the static root tileset.json, it only depends on the tiling configuration.
 */
const storeRootTileset = async (storage: TilesStorage, tiling: TilingConfig): Promise<void> => {
  const tileset = buildRootTileset({
    rootGeometricError: tiling.rootGeometricError,
    minHeight: tiling.minHeight,
    maxHeight: tiling.maxHeight,
    subtreeLevels: tiling.subtreeLevels,
    availableLevels: Math.max(...tiling.contentLevels) + 1,
    contentUriTemplate,
    subtreeUriTemplate,
  });
  await storage.put(TILESET_KEY, Buffer.from(JSON.stringify(tileset, null, JSON_INDENT)), JSON_CONTENT_TYPE);
};

export { storeRootTileset, HEMISPHERE_ROOTS };

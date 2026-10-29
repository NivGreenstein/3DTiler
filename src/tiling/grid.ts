// Tiling grid helpers.
// Jobs and storage use the WorldCRS84Quad grid (2x1 tiles at level 0, y = 0 at the north edge), the same grid retiler and
// metatile-queue-populator use. The 3D tileset is made of two implicit quadtrees, one per hemisphere, whose roots are the two
// level 0 WorldCRS84Quad tiles, so an implicit level equals a WorldCRS84Quad level. Implicit tiling counts y from the south edge.

const QUADTREE_FACTOR = 2;
const DEGREES_IN_HEMISPHERE = 180;
const MIN_LON = -180;
const MAX_LAT = 90;
const MIN_LAT = -90;

/**
 * A tile in the WorldCRS84Quad grid, y counted from the north edge.
 */
interface GridTile {
  z: number;
  x: number;
  y: number;
}

type Hemisphere = 0 | 1;

/**
 * A tile in one of the two hemisphere implicit quadtrees, y counted from the south edge.
 */
interface ImplicitTile {
  hemisphere: Hemisphere;
  level: number;
  x: number;
  y: number;
}

interface BoundingBox {
  west: number;
  south: number;
  east: number;
  north: number;
}

/**
 * A job tile as produced by metatile-queue-populator, x and y are counted in metatile units at zoom z.
 */
interface MetatileTile extends GridTile {
  metatile: number;
}

/**
 * A rectangle of grid tiles at one level, the bounds are inclusive.
 */
interface TileRange {
  z: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

const tilesPerAxis = (level: number): number => QUADTREE_FACTOR ** level;

const tileSizeInDegrees = (level: number): number => DEGREES_IN_HEMISPHERE / tilesPerAxis(level);

const assertNonNegativeInteger = (value: number, name: string): void => {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non negative integer, got ${value}`);
  }
};

const validateGridTile = (tile: GridTile): void => {
  assertNonNegativeInteger(tile.z, 'z');
  assertNonNegativeInteger(tile.x, 'x');
  assertNonNegativeInteger(tile.y, 'y');
  if (tile.x >= QUADTREE_FACTOR * tilesPerAxis(tile.z) || tile.y >= tilesPerAxis(tile.z)) {
    throw new RangeError(`tile ${tile.z}/${tile.x}/${tile.y} is out of the grid bounds`);
  }
};

/**
 * Converts a metatile job tile into the single grid tile that covers the same area.
 * A tile at zoom z with metatile m covers m x m tiles at zoom z, which is one tile at zoom z - log2(m).
 */
const metatileToGridTile = (tile: MetatileTile): GridTile => {
  const levelsUp = Math.log2(tile.metatile);
  if (!Number.isInteger(levelsUp) || levelsUp < 0) {
    throw new RangeError(`metatile must be a power of 2, got ${tile.metatile}`);
  }
  if (levelsUp > tile.z) {
    throw new RangeError(`metatile ${tile.metatile} is too large for zoom ${tile.z}`);
  }

  const gridTile = { z: tile.z - levelsUp, x: tile.x, y: tile.y };
  validateGridTile(gridTile);
  return gridTile;
};

const gridTileToBoundingBox = (tile: GridTile): BoundingBox => {
  const size = tileSizeInDegrees(tile.z);
  const west = MIN_LON + tile.x * size;
  const north = MAX_LAT - tile.y * size;
  return { west, south: north - size, east: west + size, north };
};

const gridToImplicit = (tile: GridTile): ImplicitTile => {
  validateGridTile(tile);
  const count = tilesPerAxis(tile.z);
  const hemisphere: Hemisphere = tile.x < count ? 0 : 1;
  return { hemisphere, level: tile.z, x: tile.x - hemisphere * count, y: count - 1 - tile.y };
};

const implicitToGrid = (tile: ImplicitTile): GridTile => {
  const count = tilesPerAxis(tile.level);
  return { z: tile.level, x: tile.x + tile.hemisphere * count, y: count - 1 - tile.y };
};

/**
 * Returns all the grid tiles at the given level that are inside the given tile, ordered by y and then by x.
 */
const getDescendantsAtLevel = (tile: GridTile, level: number): GridTile[] => {
  if (level < tile.z) {
    throw new RangeError(`level ${level} is above the tile level ${tile.z}`);
  }

  const span = tilesPerAxis(level - tile.z);
  const descendants: GridTile[] = [];
  for (let y = tile.y * span; y < (tile.y + 1) * span; y++) {
    for (let x = tile.x * span; x < (tile.x + 1) * span; x++) {
      descendants.push({ z: level, x, y });
    }
  }
  return descendants;
};

/**
 * Returns the ancestor of the tile at the given level (or the tile itself when the level is the tile level).
 */
const getAncestorAtLevel = (tile: GridTile, level: number): GridTile => {
  if (level > tile.z || level < 0) {
    throw new RangeError(`level ${level} is not between 0 and the tile level ${tile.z}`);
  }

  const shift = tile.z - level;
  return { z: level, x: Math.floor(tile.x / tilesPerAxis(shift)), y: Math.floor(tile.y / tilesPerAxis(shift)) };
};

/**
 * Returns the content tiles that a metatile job is responsible for, per content level.
 * Every content level must be at or below the metatile area level.
 */
const getMetatileContentTiles = (tile: MetatileTile, contentLevels: readonly number[]): GridTile[] => {
  const area = metatileToGridTile(tile);
  return contentLevels.flatMap((level) => getDescendantsAtLevel(area, level));
};

/**
 * Returns the range of the descendants of the tile at the given level.
 */
const getDescendantRange = (tile: GridTile, level: number): TileRange => {
  if (level < tile.z) {
    throw new RangeError(`level ${level} is above the tile level ${tile.z}`);
  }
  const span = tilesPerAxis(level - tile.z);
  return { z: level, minX: tile.x * span, maxX: (tile.x + 1) * span - 1, minY: tile.y * span, maxY: (tile.y + 1) * span - 1 };
};

/**
 * Returns, per content level, the range of content tiles that a metatile job is responsible for.
 */
const getMetatileContentRanges = (tile: MetatileTile, contentLevels: readonly number[]): TileRange[] => {
  const area = metatileToGridTile(tile);
  return contentLevels.map((level) => getDescendantRange(area, level));
};

/**
 * Returns the roots of every subtree that holds tiles of the area, from the hemisphere root down to the deepest level.
 */
const getSubtreeRootsOfArea = (area: GridTile, deepestLevel: number, subtreeLevels: number): ImplicitTile[] => {
  const roots: ImplicitTile[] = [];
  for (let level = 0; level <= deepestLevel; level += subtreeLevels) {
    const tiles = level <= area.z ? [getAncestorAtLevel(area, level)] : getDescendantsAtLevel(area, level);
    roots.push(...tiles.map(gridToImplicit));
  }
  return roots;
};

/**
 * Returns the root of the subtree that contains the implicit tile.
 */
const getSubtreeRoot = (tile: ImplicitTile, subtreeLevels: number): ImplicitTile => {
  assertNonNegativeInteger(subtreeLevels, 'subtreeLevels');
  if (subtreeLevels === 0) {
    throw new RangeError('subtreeLevels must be positive');
  }

  const level = Math.floor(tile.level / subtreeLevels) * subtreeLevels;
  const shift = tilesPerAxis(tile.level - level);
  return { hemisphere: tile.hemisphere, level, x: Math.floor(tile.x / shift), y: Math.floor(tile.y / shift) };
};

/**
 * Returns the center of the tile in degrees.
 */
const getTileCenter = (tile: GridTile): { lon: number; lat: number } => {
  const { west, south, east, north } = gridTileToBoundingBox(tile);
  return { lon: (west + east) / QUADTREE_FACTOR, lat: (south + north) / QUADTREE_FACTOR };
};

/**
 * Returns the grid tile at the given level that contains the point, points on a tile edge belong to the tile to their east and south,
 * except on the east and south edges of the grid.
 */
const lonLatToGridTile = (lon: number, lat: number, level: number): GridTile => {
  if (lon < MIN_LON || lon > -MIN_LON || lat < MIN_LAT || lat > MAX_LAT) {
    throw new RangeError(`point (${lon}, ${lat}) is out of the grid bounds`);
  }

  const size = tileSizeInDegrees(level);
  const x = Math.min(Math.floor((lon - MIN_LON) / size), QUADTREE_FACTOR * tilesPerAxis(level) - 1);
  const y = Math.min(Math.floor((MAX_LAT - lat) / size), tilesPerAxis(level) - 1);
  return { z: level, x, y };
};

export {
  getDescendantRange,
  getSubtreeRootsOfArea,
  getMetatileContentRanges,
  validateGridTile,
  metatileToGridTile,
  gridTileToBoundingBox,
  gridToImplicit,
  implicitToGrid,
  getDescendantsAtLevel,
  getAncestorAtLevel,
  getMetatileContentTiles,
  getSubtreeRoot,
  getTileCenter,
  lonLatToGridTile,
};
export type { TileRange, GridTile, Hemisphere, ImplicitTile, BoundingBox, MetatileTile };

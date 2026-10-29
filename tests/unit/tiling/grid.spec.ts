import { describe, it, expect } from 'vitest';
import { TILEGRID_WORLD_CRS84, tileToBoundingBox } from '@map-colonies/tile-calc';
import {
  getAncestorAtLevel,
  getDescendantsAtLevel,
  getMetatileContentTiles,
  getSubtreeRoot,
  getTileCenter,
  gridTileToBoundingBox,
  gridToImplicit,
  implicitToGrid,
  lonLatToGridTile,
  metatileToGridTile,
} from '@src/tiling/grid';

describe('grid', () => {
  describe('#gridTileToBoundingBox', () => {
    it('should return the hemispheres for level 0', () => {
      expect(gridTileToBoundingBox({ z: 0, x: 0, y: 0 })).toEqual({ west: -180, south: -90, east: 0, north: 90 });
      expect(gridTileToBoundingBox({ z: 0, x: 1, y: 0 })).toEqual({ west: 0, south: -90, east: 180, north: 90 });
    });

    it('should count y from the north edge like WorldCRS84Quad', () => {
      expect(gridTileToBoundingBox({ z: 1, x: 0, y: 0 })).toEqual({ west: -180, south: 0, east: -90, north: 90 });
      expect(gridTileToBoundingBox({ z: 1, x: 3, y: 1 })).toEqual({ west: 90, south: -90, east: 180, north: 0 });
    });
  });

  describe('compatibility with @map-colonies/tile-calc WorldCRS84Quad', () => {
    const metatiles = [
      { z: 0, x: 1, y: 0, metatile: 1 },
      { z: 5, x: 40, y: 9, metatile: 1 },
      { z: 13, x: 9983, y: 1395, metatile: 1 },
      { z: 16, x: 4992, y: 697, metatile: 8 },
    ];

    it.each(metatiles)('should cover the same area as tile-calc for $z/$x/$y with a metatile of $metatile', (metatile) => {
      expect(gridTileToBoundingBox(metatileToGridTile(metatile))).toEqual(tileToBoundingBox(metatile, TILEGRID_WORLD_CRS84));
    });
  });

  describe('#metatileToGridTile', () => {
    it('should return the same tile for a metatile of 1', () => {
      expect(metatileToGridTile({ z: 13, x: 9983, y: 1395, metatile: 1 })).toEqual({ z: 13, x: 9983, y: 1395 });
    });

    it('should return the covering tile for a larger metatile', () => {
      // a zoom 1 tile with a metatile of 2 covers the whole west hemisphere
      expect(metatileToGridTile({ z: 1, x: 0, y: 0, metatile: 2 })).toEqual({ z: 0, x: 0, y: 0 });
      expect(metatileToGridTile({ z: 14, x: 3, y: 5, metatile: 8 })).toEqual({ z: 11, x: 3, y: 5 });
    });

    it('should throw for a metatile that is not a power of 2', () => {
      expect(() => metatileToGridTile({ z: 14, x: 0, y: 0, metatile: 3 })).toThrow(RangeError);
    });

    it('should throw for a metatile that is out of the grid', () => {
      expect(() => metatileToGridTile({ z: 1, x: 0, y: 0, metatile: 4 })).toThrow(RangeError);
      expect(() => metatileToGridTile({ z: 1, x: 4, y: 0, metatile: 1 })).toThrow(RangeError);
    });
  });

  describe('#gridToImplicit', () => {
    it('should map west and east tiles to their hemisphere and flip y', () => {
      expect(gridToImplicit({ z: 0, x: 0, y: 0 })).toEqual({ hemisphere: 0, level: 0, x: 0, y: 0 });
      expect(gridToImplicit({ z: 0, x: 1, y: 0 })).toEqual({ hemisphere: 1, level: 0, x: 0, y: 0 });
      expect(gridToImplicit({ z: 2, x: 5, y: 0 })).toEqual({ hemisphere: 1, level: 2, x: 1, y: 3 });
    });

    it('should round trip', () => {
      const tiles = [
        { z: 0, x: 1, y: 0 },
        { z: 3, x: 2, y: 7 },
        { z: 15, x: 39000, y: 10000 },
      ];
      for (const tile of tiles) {
        expect(implicitToGrid(gridToImplicit(tile))).toEqual(tile);
      }
    });
  });

  describe('#getDescendantsAtLevel and #getAncestorAtLevel', () => {
    it('should return the 4 children of a tile', () => {
      expect(getDescendantsAtLevel({ z: 1, x: 1, y: 1 }, 2)).toEqual([
        { z: 2, x: 2, y: 2 },
        { z: 2, x: 3, y: 2 },
        { z: 2, x: 2, y: 3 },
        { z: 2, x: 3, y: 3 },
      ]);
    });

    it('should have every descendant point back to the tile', () => {
      const tile = { z: 13, x: 8379, y: 2112 };
      for (const descendant of getDescendantsAtLevel(tile, 15)) {
        expect(getAncestorAtLevel(descendant, 13)).toEqual(tile);
      }
    });
  });

  describe('#getMetatileContentTiles', () => {
    it('should return 4 tiles at z14 and 16 tiles at z15 for a z13 metatile', () => {
      const tiles = getMetatileContentTiles({ z: 13, x: 8379, y: 2112, metatile: 1 }, [14, 15]);

      expect(tiles.filter((t) => t.z === 14)).toHaveLength(4);
      expect(tiles.filter((t) => t.z === 15)).toHaveLength(16);
    });

    it('should throw if a content level is above the metatile area', () => {
      expect(() => getMetatileContentTiles({ z: 14, x: 0, y: 0, metatile: 1 }, [13])).toThrow(RangeError);
    });
  });

  describe('#getSubtreeRoot', () => {
    it('should return the subtree root at a multiple of the subtree levels', () => {
      expect(getSubtreeRoot({ hemisphere: 1, level: 7, x: 100, y: 50 }, 8)).toEqual({ hemisphere: 1, level: 0, x: 0, y: 0 });
      expect(getSubtreeRoot({ hemisphere: 1, level: 15, x: 33000, y: 16000 }, 8)).toEqual({ hemisphere: 1, level: 8, x: 257, y: 125 });
      expect(getSubtreeRoot({ hemisphere: 0, level: 8, x: 3, y: 4 }, 8)).toEqual({ hemisphere: 0, level: 8, x: 3, y: 4 });
    });
  });

  describe('#lonLatToGridTile', () => {
    it('should find the tile of a point in Tel Aviv', () => {
      const tile = lonLatToGridTile(34.78, 32.08, 13);
      const { west, south, east, north } = gridTileToBoundingBox(tile);

      expect(34.78).toBeGreaterThanOrEqual(west);
      expect(34.78).toBeLessThan(east);
      expect(32.08).toBeGreaterThan(south);
      expect(32.08).toBeLessThanOrEqual(north);
    });

    it('should keep the grid corners inside the grid', () => {
      expect(lonLatToGridTile(180, -90, 2)).toEqual({ z: 2, x: 7, y: 3 });
      expect(lonLatToGridTile(-180, 90, 2)).toEqual({ z: 2, x: 0, y: 0 });
    });

    it('should return a tile whose center maps back to it', () => {
      const tile = { z: 15, x: 39012, y: 10582 };
      const { lon, lat } = getTileCenter(tile);

      expect(lonLatToGridTile(lon, lat, 15)).toEqual(tile);
    });

    it('should throw for a point outside the grid', () => {
      expect(() => lonLatToGridTile(181, 0, 1)).toThrow(RangeError);
    });
  });
});

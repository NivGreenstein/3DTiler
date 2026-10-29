import { describe, it, expect } from 'vitest';
import { buildRootTileset } from '@src/tiling/tileset';

describe('tileset', () => {
  describe('#buildRootTileset', () => {
    const tileset = buildRootTileset({
      rootGeometricError: 800000,
      minHeight: -500,
      maxHeight: 6000,
      subtreeLevels: 8,
      availableLevels: 16,
      contentUriTemplate: (hemisphere) => `content/${hemisphere}/{level}/{x}/{y}.glb`,
      subtreeUriTemplate: (hemisphere) => `subtrees/${hemisphere}/{level}/{x}/{y}.subtree`,
    });

    it('should be a 3D Tiles 1.1 tileset with an empty root and two implicit children', () => {
      expect(tileset.asset.version).toBe('1.1');
      expect(tileset.root).not.toHaveProperty('content');
      expect(tileset.root.children).toHaveLength(2);
      expect(tileset.root.geometricError).toBeGreaterThan(tileset.root.children[0]?.geometricError as number);
    });

    it('should split the world into a west and an east hemisphere', () => {
      const [west, east] = tileset.root.children;

      expect(west?.boundingVolume.region).toEqual([-Math.PI, -Math.PI / 2, 0, Math.PI / 2, -500, 6000]);
      expect(east?.boundingVolume.region).toEqual([0, -Math.PI / 2, Math.PI, Math.PI / 2, -500, 6000]);
      expect(tileset.root.boundingVolume.region).toEqual([-Math.PI, -Math.PI / 2, Math.PI, Math.PI / 2, -500, 6000]);
    });

    it('should give each hemisphere its own content and subtree paths', () => {
      const [west, east] = tileset.root.children;

      expect(west?.content.uri).toBe('content/0/{level}/{x}/{y}.glb');
      expect(east?.content.uri).toBe('content/1/{level}/{x}/{y}.glb');
      expect(east?.implicitTiling).toEqual({
        subdivisionScheme: 'QUADTREE',
        subtreeLevels: 8,
        availableLevels: 16,
        subtrees: { uri: 'subtrees/1/{level}/{x}/{y}.subtree' },
      });
    });
  });
});

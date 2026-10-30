import { describe, it, expect } from 'vitest';
import { computeSubtreeAvailability, countTilesInLevels, isBitSet, mortonIndex, writeSubtree } from '@src/tiling/subtree';

interface SubtreeJson {
  tileAvailability: { constant?: number; bitstream?: number; availableCount?: number };
  contentAvailability: { constant?: number; bitstream?: number; availableCount?: number }[];
  childSubtreeAvailability: { constant?: number; bitstream?: number; availableCount?: number };
  buffers?: { byteLength: number }[];
  bufferViews?: { buffer: number; byteOffset: number; byteLength: number }[];
}

const readSubtree = (buffer: Buffer): { json: SubtreeJson; binary: Buffer } => {
  const jsonLength = Number(buffer.readBigUInt64LE(8));
  const binaryLength = Number(buffer.readBigUInt64LE(16));

  expect(buffer.byteLength).toBe(24 + jsonLength + binaryLength);

  const json = JSON.parse(buffer.subarray(24, 24 + jsonLength).toString('utf-8')) as SubtreeJson;
  return { json, binary: buffer.subarray(24 + jsonLength) };
};

describe('subtree', () => {
  describe('#mortonIndex', () => {
    it('should interleave x into the even bits and y into the odd bits', () => {
      expect(mortonIndex(0, 0)).toBe(0);
      expect(mortonIndex(1, 0)).toBe(1);
      expect(mortonIndex(0, 1)).toBe(2);
      expect(mortonIndex(1, 1)).toBe(3);
      expect(mortonIndex(2, 0)).toBe(4);
      expect(mortonIndex(3, 5)).toBe(0b100111);
    });
  });

  describe('#countTilesInLevels', () => {
    it('should count the tiles of the first levels of a quadtree', () => {
      expect(countTilesInLevels(1)).toBe(1);
      expect(countTilesInLevels(2)).toBe(5);
      expect(countTilesInLevels(8)).toBe(21845);
    });
  });

  describe('#computeSubtreeAvailability', () => {
    it('should mark a content tile, its ancestors, and nothing else', () => {
      const root = { hemisphere: 1 as const, level: 0, x: 0, y: 0 };
      // level 2 tile (3, 1): its level 1 ancestor is (1, 0)
      const availability = computeSubtreeAvailability(root, 3, [{ hemisphere: 1, level: 2, x: 3, y: 1 }]);

      const available = [...Array(availability.tileCount).keys()].filter((i) => isBitSet(availability.tile, i));

      expect(available).toEqual([0, 1 + mortonIndex(1, 0), 5 + mortonIndex(3, 1)]);

      const content = [...Array(availability.tileCount).keys()].filter((i) => isBitSet(availability.content, i));

      expect(content).toEqual([5 + mortonIndex(3, 1)]);
    });

    it('should mark child subtrees for tiles below the subtree levels', () => {
      const root = { hemisphere: 0 as const, level: 8, x: 10, y: 20 };
      // a level 10 tile inside the root, below a 2 level subtree
      const tile = { hemisphere: 0 as const, level: 10, x: 10 * 4 + 3, y: 20 * 4 + 2 };

      const availability = computeSubtreeAvailability(root, 2, [tile]);

      const children = [...Array(availability.childSubtreeCount).keys()].filter((i) => isBitSet(availability.childSubtree, i));

      expect(children).toEqual([mortonIndex(3, 2)]);
      expect(isBitSet(availability.tile, 0)).toBe(true);
      expect(isBitSet(availability.tile, 1 + mortonIndex(1, 1))).toBe(true);
    });

    it('should throw for a tile outside the subtree', () => {
      const root = { hemisphere: 0 as const, level: 8, x: 10, y: 20 };

      expect(() => computeSubtreeAvailability(root, 8, [{ hemisphere: 0, level: 14, x: 0, y: 0 }])).toThrow(RangeError);
      expect(() => computeSubtreeAvailability(root, 8, [{ hemisphere: 1, level: 8, x: 10, y: 20 }])).toThrow(RangeError);
    });

    it('should only make the root available when forced for an empty subtree', () => {
      const root = { hemisphere: 0 as const, level: 0, x: 0, y: 0 };

      expect(isBitSet(computeSubtreeAvailability(root, 8, []).tile, 0)).toBe(false);
      expect(isBitSet(computeSubtreeAvailability(root, 8, [], true).tile, 0)).toBe(true);
    });
  });

  describe('#writeSubtree', () => {
    it('should write constants and no buffer for an empty subtree', () => {
      const buffer = writeSubtree(computeSubtreeAvailability({ hemisphere: 0, level: 0, x: 0, y: 0 }, 8, []));

      expect(buffer.readUInt32LE(0)).toBe(0x74627573);
      expect(buffer.readUInt32LE(4)).toBe(1);

      const { json, binary } = readSubtree(buffer);

      expect(json).toEqual({ tileAvailability: { constant: 0 }, contentAvailability: [{ constant: 0 }], childSubtreeAvailability: { constant: 0 } });
      expect(binary).toHaveLength(0);
    });

    it('should write 8 byte aligned bitstreams that read back the same bits', () => {
      const root = { hemisphere: 1 as const, level: 8, x: 264, y: 197 };
      const tiles = [
        { hemisphere: 1 as const, level: 14, x: 264 * 64 + 5, y: 197 * 64 + 9 },
        { hemisphere: 1 as const, level: 15, x: 264 * 128 + 11, y: 197 * 128 + 18 },
      ];
      const availability = computeSubtreeAvailability(root, 8, tiles);

      const buffer = writeSubtree(availability);

      expect(buffer.byteLength % 8).toBe(0);

      const { json, binary } = readSubtree(buffer);

      expect(json.childSubtreeAvailability).toEqual({ constant: 0 });
      expect(json.tileAvailability.availableCount).toBe(6 + 7 - 5);
      expect(json.contentAvailability[0]?.availableCount).toBe(2);

      for (const view of json.bufferViews ?? []) {
        expect(view.byteOffset % 8).toBe(0);
      }
      const contentView = json.bufferViews?.[json.contentAvailability[0]?.bitstream as number];
      const contentBits = binary.subarray(contentView?.byteOffset, (contentView?.byteOffset as number) + (contentView?.byteLength as number));

      expect(isBitSet(contentBits, countTilesInLevels(6) + mortonIndex(5, 9))).toBe(true);
      expect(isBitSet(contentBits, countTilesInLevels(7) + mortonIndex(11, 18))).toBe(true);
    });
  });
});

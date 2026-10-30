import { jsLogger } from '@map-colonies/js-logger';
import { describe, beforeEach, it, expect, vi, type Mock } from 'vitest';
import type { ConfigType } from '@common/config';
import type { BuildingRepository } from '@src/building/DAL/buildingRepository';
import { SubtreeProcessor } from '@src/tiler/subtrees/subtreeProcessor';
import type { TilesStorage } from '@src/tiler/tilesStorage/interfaces';
import type { GridTile, TileRange } from '@src/tiling/grid';

const tiling = { contentLevels: [14, 15], subtreeLevels: 8, geometryBuilder: 'node', rootGeometricError: 800000, minHeight: -500, maxHeight: 6000 };
const config = { get: (path: string) => (path === 'app.tiling' ? tiling : undefined) } as unknown as ConfigType;

describe('SubtreeProcessor', () => {
  let repository: { findDistinctTiles: Mock<BuildingRepository['findDistinctTiles']> };
  let storage: { put: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn>; exists: ReturnType<typeof vi.fn> };
  let processor: SubtreeProcessor;

  beforeEach(async () => {
    repository = { findDistinctTiles: vi.fn<BuildingRepository['findDistinctTiles']>().mockResolvedValue([]) };
    storage = { put: vi.fn(), delete: vi.fn(), exists: vi.fn() };
    processor = new SubtreeProcessor(
      await jsLogger({ enabled: false }),
      config,
      repository as unknown as BuildingRepository,
      storage as unknown as TilesStorage
    );
  });

  it('should ask for the content tiles of a level 8 subtree at their own level', async () => {
    const subtree = { hemisphere: 1 as const, level: 8, x: 8, y: 200 };
    // the grid tile of the subtree root is 264/55 (y from the north)
    repository.findDistinctTiles.mockImplementation(async (range: TileRange, level: number): Promise<GridTile[]> =>
      Promise.resolve(range.z === 15 ? [{ z: level, x: range.minX + 3, y: range.minY + 5 }] : [])
    );

    await processor.processSubtree(subtree);

    expect(repository.findDistinctTiles).toHaveBeenCalledWith({ z: 14, minX: 264 * 64, maxX: 265 * 64 - 1, minY: 55 * 64, maxY: 56 * 64 - 1 }, 14);
    expect(repository.findDistinctTiles).toHaveBeenCalledWith(
      { z: 15, minX: 264 * 128, maxX: 265 * 128 - 1, minY: 55 * 128, maxY: 56 * 128 - 1 },
      15
    );
    expect(storage.put).toHaveBeenCalledWith('subtrees/1/8/8/200.subtree', expect.any(Buffer), 'application/octet-stream');
  });

  it('should ask a hemisphere root subtree for the level 8 tiles that have content', async () => {
    await processor.processSubtree({ hemisphere: 0, level: 0, x: 0, y: 0 });

    expect(repository.findDistinctTiles).toHaveBeenCalledWith(expect.objectContaining({ z: 14 }), 8);
    expect(repository.findDistinctTiles).toHaveBeenCalledWith(expect.objectContaining({ z: 15 }), 8);
  });

  it('should always store a hemisphere root subtree, even without content', async () => {
    await processor.processSubtree({ hemisphere: 0, level: 0, x: 0, y: 0 });

    expect(storage.put).toHaveBeenCalledWith('subtrees/0/0/0/0.subtree', expect.any(Buffer), 'application/octet-stream');
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('should delete a subtree that has no content anymore', async () => {
    await processor.processSubtree({ hemisphere: 1, level: 8, x: 8, y: 200 });

    expect(storage.delete).toHaveBeenCalledWith(['subtrees/1/8/8/200.subtree']);
    expect(storage.put).not.toHaveBeenCalled();
  });
});

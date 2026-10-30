import { jsLogger } from '@map-colonies/js-logger';
import { trace } from '@opentelemetry/api';
import { Registry } from 'prom-client';
import { describe, beforeEach, it, expect, vi } from 'vitest';
import type { ConfigType } from '@common/config';
import { TileProcessor } from '@src/tiler/tileProcessor';
import type { GeometryBuilder, TileContent } from '@src/mesh/geometryBuilder/interfaces';
import { MeshBuilder } from '@src/mesh/meshBuilder';
import { triangulateFace } from '@src/mesh/triangulate';
import type { TilesStorage } from '@src/tiler/tilesStorage/interfaces';
import type { SubtreeJobQueue } from '@src/tiler/subtrees/subtreeJobQueue';
import type { GridTile } from '@src/tiling/grid';

const tiling = { contentLevels: [14, 15], subtreeLevels: 8, geometryBuilder: 'node', rootGeometricError: 800000, minHeight: -500, maxHeight: 6000 };
const config = { get: (path: string) => (path === 'app.tiling' ? tiling : undefined) } as unknown as ConfigType;

const createContent = (): TileContent => {
  const meshBuilder = new MeshBuilder();
  const face = triangulateFace([[0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0]]);
  meshBuilder.addFace(0, 1, face?.vertices ?? [], face?.indices ?? [], face?.normal ?? [0, 0, 1]);
  return {
    features: [{ id: 'a-0', buildingId: 'a', height: 10, groundHeight: 100, constructionYear: 2000, roofType: 'flat' }],
    mesh: meshBuilder.build(),
  };
};

describe('TileProcessor', () => {
  // the z13 tile 8457/1781 in Valkenburg, as a z16 job with a metatile of 8
  const job = { z: 16, x: 8457, y: 1781, metatile: 8 };
  const contentTile: GridTile = { z: 15, x: 8457 * 4 + 1, y: 1781 * 4 + 2 };

  let builder: { buildTile: ReturnType<typeof vi.fn> };
  let storage: { put: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn>; exists: ReturnType<typeof vi.fn> };
  let subtreeQueue: { enqueue: ReturnType<typeof vi.fn> };
  let processor: TileProcessor;

  beforeEach(async () => {
    builder = {
      buildTile: vi.fn(async (tile: GridTile) =>
        Promise.resolve(tile.z === contentTile.z && tile.x === contentTile.x && tile.y === contentTile.y ? createContent() : undefined)
      ),
    };
    storage = { put: vi.fn(), delete: vi.fn(), exists: vi.fn() };
    subtreeQueue = { enqueue: vi.fn() };
    processor = new TileProcessor(
      await jsLogger({ enabled: false }),
      trace.getTracer('test'),
      config,
      builder as unknown as GeometryBuilder,
      storage as unknown as TilesStorage,
      subtreeQueue as unknown as SubtreeJobQueue,
      new Registry(),
      [1]
    );
  });

  it('should build all 20 content tiles of a z13 area, store the non empty one and delete the empty ones', async () => {
    const result = await processor.processMetatile(job);

    expect(result).toEqual({ stored: 1, empty: 19 });
    expect(builder.buildTile).toHaveBeenCalledTimes(20);
    expect(storage.put).toHaveBeenCalledTimes(1);

    // east hemisphere, implicit y counted from the south
    const [key, glb, contentType] = storage.put.mock.calls[0] as [string, Buffer, string];

    expect(key).toBe(`content/1/15/${contentTile.x - 2 ** 15}/${2 ** 15 - 1 - contentTile.y}.glb`);
    expect(glb.readUInt32LE(0)).toBe(0x46546c67);
    expect(contentType).toBe('model/gltf-binary');
    expect(storage.delete).toHaveBeenCalledTimes(19);
  });

  it('should queue the rebuild of the hemisphere root subtree and of the level 8 subtree of the area', async () => {
    await processor.processMetatile(job);

    expect(subtreeQueue.enqueue).toHaveBeenCalledWith([
      { hemisphere: 1, level: 0, x: 0, y: 0 },
      { hemisphere: 1, level: 8, x: 8, y: 200 },
    ]);
  });

  it('should fail the job when a tile fails to build', async () => {
    builder.buildTile.mockRejectedValueOnce(new Error('db down'));

    await expect(processor.processMetatile(job)).rejects.toThrow('db down');
    expect(subtreeQueue.enqueue).not.toHaveBeenCalled();
  });
});

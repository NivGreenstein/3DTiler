import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { jsLogger } from '@map-colonies/js-logger';
import { describe, beforeEach, afterEach, it, expect } from 'vitest';
import { FsTilesStorage } from '@src/tiler/tilesStorage/fsTilesStorage';
import type { TilesStorage } from '@src/tiler/tilesStorage/interfaces';

describe('FsTilesStorage', () => {
  let basePath: string;
  let storage: TilesStorage;

  beforeEach(async () => {
    basePath = await mkdtemp(path.join(tmpdir(), 'tiles-'));
    storage = new FsTilesStorage(await jsLogger({ enabled: false }), basePath);
  });

  afterEach(async () => {
    await rm(basePath, { recursive: true, force: true });
  });

  it('should write a file under its key without leaving temporary files', async () => {
    await storage.put('content/1/15/3/4.glb', Buffer.from('glb'), 'model/gltf-binary');

    await expect(readFile(path.join(basePath, 'content/1/15/3/4.glb'), 'utf-8')).resolves.toBe('glb');
    await expect(readdir(path.join(basePath, 'content/1/15/3'))).resolves.toEqual(['4.glb']);
    await expect(storage.exists('content/1/15/3/4.glb')).resolves.toBe(true);
  });

  it('should delete files and ignore missing ones', async () => {
    await storage.put('a.json', Buffer.from('{}'), 'application/json');

    await storage.delete(['a.json', 'missing.glb']);

    await expect(storage.exists('a.json')).resolves.toBe(false);
  });

  it('should refuse keys outside the base path', async () => {
    await expect(storage.put('../escape.glb', Buffer.from(''), 'model/gltf-binary')).rejects.toThrow('outside');
  });
});

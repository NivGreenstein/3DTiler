import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Logger } from '@map-colonies/js-logger';
import type { TilesStorage } from './interfaces';

/**
 * Stores the tileset in a directory. Files are written to a temporary name and renamed, so readers never see a partial file.
 */
export class FsTilesStorage implements TilesStorage {
  private readonly basePath: string;

  public constructor(
    private readonly logger: Logger,
    basePath: string
  ) {
    this.basePath = path.resolve(basePath);
    this.logger.info({ msg: 'initializing fs tiles storage', basePath: this.basePath });
  }

  public async put(key: string, data: Buffer): Promise<void> {
    const filePath = this.resolve(key);
    await mkdir(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, data);
    await rename(temporaryPath, filePath);
  }

  public async delete(keys: string[]): Promise<void> {
    await Promise.all(keys.map(async (key) => rm(this.resolve(key), { force: true })));
  }

  public async exists(key: string): Promise<boolean> {
    try {
      await stat(this.resolve(key));
      return true;
    } catch {
      return false;
    }
  }

  private resolve(key: string): string {
    const filePath = path.resolve(this.basePath, key);
    if (!filePath.startsWith(this.basePath + path.sep)) {
      throw new Error(`key ${key} is outside the storage base path`);
    }
    return filePath;
  }
}

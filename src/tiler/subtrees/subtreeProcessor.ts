import { type Logger } from '@map-colonies/js-logger';
import { inject, injectable } from 'tsyringe';
import { SERVICES, TILES_STORAGE } from '@common/constants';
import type { ConfigType } from '@common/config';
import type { TilingConfig } from '@common/configSchema';
import { BUILDING_CUSTOM_REPOSITORY_SYMBOL, type BuildingRepository } from '@src/building/DAL/buildingRepository';
import { getDescendantRange, gridToImplicit, implicitToGrid, type ImplicitTile } from '@src/tiling/grid';
import { getSubtreeKey } from '@src/tiling/layout';
import { computeSubtreeAvailability, isRootAvailable, writeSubtree } from '@src/tiling/subtree';
import type { TilesStorage } from '../tilesStorage/interfaces';
import type { SubtreeJob } from './subtreeJobQueue';

const SUBTREE_CONTENT_TYPE = 'application/octet-stream';

@injectable()
export class SubtreeProcessor {
  private readonly tiling: TilingConfig;

  public constructor(
    @inject(SERVICES.LOGGER) private readonly logger: Logger,
    @inject(SERVICES.CONFIG) config: ConfigType,
    @inject(BUILDING_CUSTOM_REPOSITORY_SYMBOL) private readonly repository: BuildingRepository,
    @inject(TILES_STORAGE) private readonly tilesStorage: TilesStorage
  ) {
    this.tiling = config.get('app.tiling');
  }

  /**
   * Rebuilds the availability of a subtree from the buildings table. A hemisphere root subtree is always written, any other subtree is
   * deleted once nothing below it has content.
   */
  public async processSubtree(subtree: SubtreeJob): Promise<void> {
    const root = implicitToGrid(subtree);
    const childSubtreeLevel = subtree.level + this.tiling.subtreeLevels;

    // content tiles inside the subtree levels, and the child subtree roots that have content below them
    const tiles: ImplicitTile[] = [];
    for (const level of this.tiling.contentLevels.filter((contentLevel) => contentLevel >= subtree.level)) {
      const range = getDescendantRange(root, level);
      const found = await this.repository.findDistinctTiles(range, Math.min(level, childSubtreeLevel));
      tiles.push(...found.map(gridToImplicit));
    }

    const isHemisphereRoot = subtree.level === 0;
    const availability = computeSubtreeAvailability(subtree, this.tiling.subtreeLevels, tiles, isHemisphereRoot);
    const key = getSubtreeKey(subtree);

    if (!isRootAvailable(availability)) {
      await this.tilesStorage.delete([key]);
      this.logger.info({ msg: 'subtree has no content, deleted', subtree, key });
      return;
    }

    await this.tilesStorage.put(key, writeSubtree(availability), SUBTREE_CONTENT_TYPE);
    this.logger.info({ msg: 'subtree stored', subtree, key, tiles: tiles.length });
  }
}

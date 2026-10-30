import type { Logger } from '@map-colonies/js-logger';
import type { FactoryFunction } from 'tsyringe';
import { JOB_QUEUE_PROVIDER, SERVICES, SUBTREE_JOB_QUEUE, TILES_STORAGE } from '@common/constants';
import { timerify } from '@common/util';
import type { ConfigType } from '@common/config';
import type { JobQueueProvider } from './tiler/interfaces';
import { TileProcessor } from './tiler/tileProcessor';
import { SubtreeProcessor } from './tiler/subtrees/subtreeProcessor';
import type { SubtreeJob, SubtreeJobQueue } from './tiler/subtrees/subtreeJobQueue';
import type { TilesStorage } from './tiler/tilesStorage/interfaces';
import { HEMISPHERE_ROOTS, storeRootTileset } from './tiler/tileset';
import type { MetatileJob } from './tiler/types';

export const consumeAndProcessFactory: FactoryFunction<() => Promise<void>> = (container) => {
  const queueProv = container.resolve<JobQueueProvider>(JOB_QUEUE_PROVIDER);
  const logger = container.resolve<Logger>(SERVICES.LOGGER);
  const config = container.resolve<ConfigType>(SERVICES.CONFIG);
  const parallelism = config.get('app.parallelism');
  const mode = config.get('app.mode');

  const consumeMetatiles = async (): Promise<void> => {
    const processor = container.resolve(TileProcessor);
    await queueProv.consumeQueue<MetatileJob>(async (job, jobId) => {
      const { parent, ...metatile } = job;

      logger.info({ msg: 'started processing metatile', jobId, metatile, parent, parallelism });

      const [result, duration] = await timerify(processor.processMetatile.bind(processor), job);

      logger.info({ msg: 'processing metatile completed successfully', jobId, duration, metatile, parent, parallelism, ...result });
    }, parallelism);
  };

  const consumeSubtrees = async (): Promise<void> => {
    const processor = container.resolve(SubtreeProcessor);
    const storage = container.resolve<TilesStorage>(TILES_STORAGE);
    const subtreeJobQueue = container.resolve<SubtreeJobQueue>(SUBTREE_JOB_QUEUE);

    // the root tileset only depends on the configuration, and both hemisphere roots must exist even without content
    await storeRootTileset(storage, config.get('app.tiling'));
    await subtreeJobQueue.enqueue(HEMISPHERE_ROOTS);
    logger.info({ msg: 'root tileset stored' });

    await queueProv.consumeQueue<SubtreeJob>(async (subtree, jobId) => {
      const [, duration] = await timerify(processor.processSubtree.bind(processor), subtree);
      logger.info({ msg: 'processing subtree completed successfully', jobId, duration, subtree });
    }, parallelism);
  };

  return mode === 'subtrees' ? consumeSubtrees : consumeMetatiles;
};

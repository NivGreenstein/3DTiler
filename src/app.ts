import type { Logger } from '@map-colonies/js-logger';
import type { FactoryFunction } from 'tsyringe';
import { JOB_QUEUE_PROVIDER, SERVICES } from '@common/constants';
import { timerify } from '@common/util';
import type { ConfigType } from '@common/config';
import type { JobQueueProvider } from './tiler/interfaces';
import { TileProcessor } from './tiler/tileProcessor';
import type { MetatileJob } from './tiler/types';

export const consumeAndProcessFactory: FactoryFunction<() => Promise<void>> = (container) => {
  const processor = container.resolve(TileProcessor);
  const queueProv = container.resolve<JobQueueProvider>(JOB_QUEUE_PROVIDER);
  const logger = container.resolve<Logger>(SERVICES.LOGGER);
  const config = container.resolve<ConfigType>(SERVICES.CONFIG);
  const parallelism = config.get('app.parallelism');

  const consumeAndProcess = async (): Promise<void> => {
    await queueProv.consumeQueue<MetatileJob>(async (job, jobId) => {
      const { parent, ...metatile } = job;

      logger.info({ msg: 'started processing metatile', jobId, metatile, parent, parallelism });

      const [, duration] = await timerify(processor.processMetatile.bind(processor), job);

      logger.info({ msg: 'processing metatile completed successfully', jobId, duration, metatile, parent, parallelism });
    }, parallelism);
  };

  return consumeAndProcess;
};

import { type Logger } from '@map-colonies/js-logger';
import { inject, injectable } from 'tsyringe';
import { SERVICES } from '@common/constants';
import type { MetatileJob } from './types';

@injectable()
export class TileProcessor {
  public constructor(@inject(SERVICES.LOGGER) private readonly logger: Logger) {}

  public async processMetatile(job: MetatileJob): Promise<void> {
    this.logger.debug({ msg: 'processing metatile', job });
    // the metatile pipeline (query, mesh, encode, store) is implemented in the next milestones
    return Promise.reject(new Error('metatile processing is not implemented yet'));
  }
}

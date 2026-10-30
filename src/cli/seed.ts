// Queues a metatile job for every metatile area that has buildings, the same jobs metatile-queue-populator would produce, and writes
// extent.json (the extent of every source) next to the tileset so the viewer can fly to the data.
// Usage: node --import ./instrumentation.mjs ./cli/seed.js [--zoom 16] [--metatile 8]
import 'reflect-metadata';
import { parseArgs } from 'node:util';
import type { Logger } from '@map-colonies/js-logger';
import type { PgBoss } from 'pg-boss';
import { ExitCodes, ON_SIGNAL, QUEUE_NAME, SERVICES, TILES_STORAGE } from '@common/constants';
import type { ConfigType } from '@common/config';
import { BUILDING_CUSTOM_REPOSITORY_SYMBOL, type BuildingRepository } from '@src/building/DAL/buildingRepository';
import { getDescendantRange, type GridTile } from '@src/tiling/grid';
import type { MetatileJob } from '@src/tiler/types';
import type { TilesStorage } from '@src/tiler/tilesStorage/interfaces';
import { registerExternalValues } from '../containerConfig';

const DEFAULT_ZOOM = '16';
const DEFAULT_METATILE = '8';
const HEMISPHERES = [0, 1];
const EXTENT_KEY = 'extent.json';
const JSON_INDENT = 2;

const { values } = parseArgs({
  options: {
    zoom: { type: 'string', default: DEFAULT_ZOOM },
    metatile: { type: 'string', default: DEFAULT_METATILE },
  },
});

const main = async (): Promise<number> => {
  const zoom = Number(values.zoom);
  const metatile = Number(values.metatile);
  const areaLevel = zoom - Math.log2(metatile);
  if (!Number.isInteger(areaLevel) || areaLevel < 0) {
    throw new Error(`zoom ${zoom} and metatile ${metatile} do not make a metatile area`);
  }

  const container = await registerExternalValues();
  const logger = container.resolve<Logger>(SERVICES.LOGGER);
  const config = container.resolve<ConfigType>(SERVICES.CONFIG);
  const repository = container.resolve<BuildingRepository>(BUILDING_CUSTOM_REPOSITORY_SYMBOL);
  const pgBoss = container.resolve<PgBoss>(SERVICES.PGBOSS);
  const queueName = container.resolve<string>(QUEUE_NAME);

  try {
    const areas = new Map<string, GridTile>();
    for (const level of config.get('app.tiling.contentLevels')) {
      for (const hemisphere of HEMISPHERES) {
        const range = getDescendantRange({ z: 0, x: hemisphere, y: 0 }, level);
        for (const area of await repository.findDistinctTiles(range, areaLevel)) {
          areas.set(`${area.x}/${area.y}`, area);
        }
      }
    }

    for (const area of areas.values()) {
      const job: MetatileJob = { z: zoom, x: area.x, y: area.y, metatile, parent: 'seed' };
      await pgBoss.send(queueName, job);
    }

    logger.info({ msg: 'queued metatile jobs', queueName, count: areas.size, zoom, metatile, areaLevel });

    const sources = await repository.findSourceExtents();
    const storage = container.resolve<TilesStorage>(TILES_STORAGE);
    await storage.put(EXTENT_KEY, Buffer.from(JSON.stringify({ sources }, null, JSON_INDENT)), 'application/json');
    logger.info({ msg: 'stored the extent of every source', sources });
    return ExitCodes.SUCCESS;
  } finally {
    await container.resolve<() => Promise<void>>(ON_SIGNAL)();
  }
};

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error('failed seeding metatile jobs', error);
    process.exit(ExitCodes.GENERAL_ERROR);
  });

/* eslint-disable @typescript-eslint/naming-convention */
export const jobAttributes = {
  JOB_ID: 'job.id',
  TILE_Z: 'tile.z',
  TILE_X: 'tile.x',
  TILE_Y: 'tile.y',
  TILE_METATILE: 'tile.metatile',
  TILE_FORCE: 'tile.force',
  TILE_STATE: 'tile.state',
} satisfies Record<string, string>;

export const spanName = {
  JOB_PROCESS: 'job.process',
} satisfies Record<string, string>;

/* eslint-disable @typescript-eslint/naming-convention */
export const jobAttributes = {
  JOB_ID: 'job.id',
  TILE_Z: 'tile.z',
  TILE_X: 'tile.x',
  TILE_Y: 'tile.y',
  TILE_METATILE: 'tile.metatile',
  TILE_FORCE: 'tile.force',
  TILE_STATE: 'tile.state',
  TILE_STATUS: 'tile.status',
  TILE_FEATURES: 'tile.features',
} satisfies Record<string, string>;

export const spanName = {
  JOB_PROCESS: 'job.process',
  METATILE_PROCESS: 'metatile.process',
  CONTENT_TILE_PROCESS: 'content_tile.process',
} satisfies Record<string, string>;

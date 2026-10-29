import { describe, it, expect, afterEach, vi } from 'vitest';
import { getConfig, initConfig } from '@common/config';

describe('config', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('should load and validate the local config files against the local schema in offline mode', async () => {
    await initConfig(true);

    const config = getConfig();

    expect(config.get('app.queueName')).toBe('3dtiler-queue');
    expect(config.get('app.jobQueue.pgBoss.ssl.enabled')).toBe(false);
    expect(config.get('app.tiling.geometryBuilder')).toBe('node');
    expect(config.get('telemetry.logger.level')).toBe('info');
  });

  it('should read the buildings db and the pg-boss db from their own environment variables', async () => {
    vi.stubEnv('DB_HOST', 'buildings-db');
    vi.stubEnv('PGBOSS_HOST', 'queue-db');
    vi.stubEnv('TILING_GEOMETRY_BUILDER', 'postgis');
    vi.stubEnv('APP_MODE', 'subtrees');

    await initConfig(true);

    const config = getConfig();

    expect(config.get('db.host')).toBe('buildings-db');
    expect(config.get('app.jobQueue.pgBoss.host')).toBe('queue-db');
    expect(config.get('app.tiling.geometryBuilder')).toBe('postgis');
    expect(config.get('app.mode')).toBe('subtrees');
  });
});

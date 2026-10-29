import { describe, it, expect } from 'vitest';
import { getConfig, initConfig } from '@common/config';

describe('config', () => {
  it('should load and validate the local config files against the local schema in offline mode', async () => {
    await initConfig(true);

    const config = getConfig();

    expect(config.get('app.queueName')).toBe('3dtiler-queue');
    expect(config.get('app.jobQueue.pgBoss.ssl.enabled')).toBe(false);
    expect(config.get('telemetry.logger.level')).toBe('info');
  });
});

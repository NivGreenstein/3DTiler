import { type ConfigInstance, config } from '@map-colonies/config';
import { tilerV1, type TilerConfig } from './configSchema';

// Choose here the type of the config instance and import this type from the entire application
type ConfigType = ConfigInstance<TilerConfig>;

let configInstance: ConfigType | undefined;

/**
 * Initializes the configuration from the local config files and environment variables.
 * This should only be called from the instrumentation file.
 * @returns A Promise that resolves when the configuration is successfully initialized.
 */
async function initConfig(offlineMode = true): Promise<void> {
  configInstance = await config({
    schema: tilerV1,
    offlineMode,
  });
}

function getConfig(): ConfigType {
  if (!configInstance) {
    throw new Error('config not initialized');
  }
  return configInstance;
}

export { getConfig, initConfig };
export type { ConfigType };

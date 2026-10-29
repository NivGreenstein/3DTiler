import { readFileSync } from 'node:fs';
import type { HealthCheck } from '@godaddy/terminus';
import { DataSource, type DataSourceOptions } from 'typeorm';
import type { FactoryFunction } from 'tsyringe';
import type { DbConfig } from '@common/configSchema';
import type { ConfigType } from '@common/config';
import { SERVICES, buildApplicationName } from '@common/constants';
import { BuildingDb } from '../../building/DAL/building';

let connectionSingleton: DataSource | undefined;

export const DATA_SOURCE_PROVIDER = Symbol('dataSourceProvider');

export const DB_ENTITIES = [BuildingDb];

export const createDataSourceOptions = (dbConfig: DbConfig, projectName?: string): DataSourceOptions => {
  const { ssl, ...connectionOptions } = dbConfig;

  const options: DataSourceOptions = {
    type: 'postgres',
    ...connectionOptions,
    entities: DB_ENTITIES,
    synchronize: false,

    applicationName: buildApplicationName(projectName),
  };

  if (ssl.enabled) {
    return {
      ...options,
      password: undefined,
      ssl: {
        key: readFileSync(ssl.key as string),
        cert: readFileSync(ssl.cert as string),
        ca: ssl.ca !== undefined && ssl.ca !== '' ? readFileSync(ssl.ca) : undefined,
      },
    };
  }

  return options;
};

export const getCachedDataSource = (dbConfig: DbConfig, projectName?: string): DataSource => {
  if (connectionSingleton?.isInitialized !== true) {
    connectionSingleton = new DataSource(createDataSourceOptions(dbConfig, projectName));
  }
  return connectionSingleton;
};

export const getDbHealthCheckFunction = (connection: DataSource, timeoutMs: number): HealthCheck => {
  return async (): Promise<void> => {
    const check = connection.query('SELECT 1').then(() => undefined);
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`db health check timed out after ${timeoutMs}ms`)), timeoutMs)
    );
    await Promise.race([check, timeout]);
  };
};

export const dataSourceFactory: FactoryFunction<DataSource> = (container) => {
  const config = container.resolve<ConfigType>(SERVICES.CONFIG);
  const { healthCheckTimeoutMs, ...dbConfig } = config.get('db');
  return getCachedDataSource(dbConfig, config.get('app.project.name'));
};

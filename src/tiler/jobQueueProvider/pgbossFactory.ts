import { readFileSync } from 'node:fs';
import { PgBoss, type ConstructorOptions } from 'pg-boss';
import { type HealthCheck } from '@godaddy/terminus';
import type { PgBossConfig as PgBossSchemaConfig } from '@common/configSchema';
import { buildApplicationName } from '@common/constants';

export type PgBossConfig = PgBossSchemaConfig & { projectName?: string };
export type PgBossFactoryOptions = PgBossConfig & Partial<ConstructorOptions>;

export const createDatabaseOptions = (dbConfig: PgBossConfig): ConstructorOptions => {
  const { ssl, ...databaseOptions } = dbConfig;

  const poolConfig: ConstructorOptions = {
    ...databaseOptions,
    // eslint-disable-next-line @typescript-eslint/naming-convention
    application_name: buildApplicationName(dbConfig.projectName),
    user: dbConfig.username,
    password: dbConfig.password,
  };

  if (ssl.enabled) {
    delete poolConfig.password;
    try {
      poolConfig.ssl = {
        key: readFileSync(ssl.key as string),
        cert: readFileSync(ssl.cert as string),
        ca: ssl.ca !== undefined && ssl.ca !== '' ? readFileSync(ssl.ca) : undefined,
      };
    } catch (error) {
      throw new Error(`Failed to load SSL certificates. Ensure the files exist and are accessible. Details: ${(error as Error).message}`, {
        cause: error,
      });
    }
  } else {
    poolConfig.ssl = false;
  }

  return poolConfig;
};

export const pgBossFactory = (bossConfig: PgBossFactoryOptions): PgBoss => {
  const databaseOptions = createDatabaseOptions(bossConfig);

  return new PgBoss({ ...bossConfig, ...databaseOptions, supervise: bossConfig.supervisor, schedule: false });
};

export const getPgBossHealthCheckFunction = (boss: PgBoss, pgbossTimeoutMs: number): HealthCheck => {
  return async (): Promise<void> => {
    const check = boss
      .getDb()
      .executeSql('SELECT 1')
      .then(() => undefined);
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`pg-boss health check timed out after ${pgbossTimeoutMs}ms`)), pgbossTimeoutMs)
    );
    await Promise.race([check, timeout]);
  };
};

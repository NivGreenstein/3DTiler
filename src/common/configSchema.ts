import { typeSymbol } from '@map-colonies/schemas/build/schemas/symbol';

// A local config schema, used with the config package in offline mode.
// Shared parts are referenced from @map-colonies/schemas and resolved locally, the type below must be kept in sync with the schema.

type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface SslConfig {
  enabled: boolean;
  ca?: string;
  cert?: string;
  key?: string;
}

export interface DbConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
  schema: string;
  ssl: SslConfig;
}

export interface PgBossConfig extends DbConfig {
  supervisor: boolean;
  healthCheckTimeoutMs: number;
}

export interface TilerConfig {
  telemetry: {
    shared: {
      serviceName?: string;
      serviceVersion?: string;
      hostname?: string;
    };
    tracing: {
      isEnabled: boolean;
      url?: string;
      traceRatio?: number;
      debug?: boolean;
    };
    logger: {
      level: LogLevel;
      prettyPrint: boolean;
      opentelemetryOptions?: {
        enabled: boolean;
        url?: string;
      };
    };
    metrics: {
      enabled: boolean;
      buckets: number[];
    };
  };
  server: {
    port: number;
  };
  app: {
    project: {
      name: string;
    };
    queueName: string;
    parallelism: number;
    jobQueue: {
      waitTimeout: number;
      pgBoss: PgBossConfig;
    };
    tiling: {
      contentLevels: number[];
    };
  };
  db: DbConfig & {
    healthCheckTimeoutMs: number;
  };
}

export const TILER_SCHEMA_ID = 'https://mapcolonies.com/vector/3dtiler/v1';

export const tilerV1 = {
  [typeSymbol]: {} as TilerConfig,
  $id: TILER_SCHEMA_ID,
  title: 'vector3dTilerV1',
  description: '3DTiler worker configuration',
  type: 'object',
  required: ['telemetry', 'server', 'app', 'db'],
  properties: {
    telemetry: {
      type: 'object',
      default: {},
      required: ['shared', 'tracing', 'logger', 'metrics'],
      properties: {
        shared: { $ref: 'https://mapcolonies.com/common/telemetry/base/v1' },
        tracing: { $ref: 'https://mapcolonies.com/common/telemetry/tracing/v1' },
        logger: { $ref: 'https://mapcolonies.com/common/telemetry/logger/v2' },
        metrics: {
          type: 'object',
          default: {},
          required: ['enabled', 'buckets'],
          properties: {
            enabled: { type: 'boolean', default: true, 'x-env-value': 'TELEMETRY_METRICS_ENABLED' },
            buckets: { type: 'array', items: { type: 'number' }, description: 'Histogram buckets in seconds' },
          },
        },
      },
    },
    server: {
      type: 'object',
      default: {},
      required: ['port'],
      properties: {
        port: { type: 'integer', minimum: 1, maximum: 65535, default: 8080, 'x-env-value': 'SERVER_PORT' },
      },
    },
    app: {
      type: 'object',
      required: ['project', 'queueName', 'parallelism', 'jobQueue', 'tiling'],
      properties: {
        project: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string', description: 'Project name', 'x-env-value': 'APP_PROJECT_NAME' },
          },
        },
        queueName: { type: 'string', description: 'Job queue name', default: '3dtiler-queue', 'x-env-value': 'QUEUE_NAME' },
        parallelism: { type: 'integer', minimum: 1, description: 'Number of parallel jobs', default: 1, 'x-env-value': 'APP_PARALLELISM' },
        jobQueue: {
          type: 'object',
          required: ['waitTimeout', 'pgBoss'],
          properties: {
            waitTimeout: { type: 'integer', description: 'Job queue wait timeout in milliseconds', 'x-env-value': 'QUEUE_WAIT_TIMEOUT' },
            pgBoss: {
              allOf: [
                { $ref: 'https://mapcolonies.com/common/db/full/v3' },
                {
                  type: 'object',
                  required: ['healthCheckTimeoutMs'],
                  properties: {
                    supervisor: { type: 'boolean', default: true, 'x-env-value': 'PGBOSS_ENABLE_SUPERVISOR' },
                    healthCheckTimeoutMs: { type: 'integer', 'x-env-value': 'PGBOSS_HEALTH_CHECK_TIMEOUT_MS' },
                  },
                },
              ],
            },
          },
        },
        tiling: {
          type: 'object',
          required: ['contentLevels'],
          properties: {
            contentLevels: {
              type: 'array',
              description: 'The levels that hold content, every building is stored in exactly one tile of one of these levels',
              items: { type: 'integer', minimum: 0 },
              minItems: 1,
              uniqueItems: true,
            },
          },
        },
      },
    },
    db: {
      description: 'The database that holds the buildings table',
      allOf: [
        { $ref: 'https://mapcolonies.com/common/db/full/v3' },
        {
          type: 'object',
          required: ['healthCheckTimeoutMs'],
          properties: {
            healthCheckTimeoutMs: { type: 'integer', default: 5000, 'x-env-value': 'DB_HEALTH_CHECK_TIMEOUT_MS' },
          },
        },
      ],
    },
  },
} as const;

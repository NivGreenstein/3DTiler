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

export type AppMode = 'tiles' | 'subtrees';
export type GeometryBuilderKind = 'node' | 'postgis';

export interface FsTilesStorageConfig {
  kind: 'fs';
  basePath: string;
}

export interface TilingConfig {
  contentLevels: number[];
  subtreeLevels: number;
  geometryBuilder: GeometryBuilderKind;
  rootGeometricError: number;
  minHeight: number;
  maxHeight: number;
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
    mode: AppMode;
    queueName: string;
    parallelism: number;
    subtrees: {
      queueName: string;
    };
    jobQueue: {
      waitTimeout: number;
      pgBoss: PgBossConfig;
    };
    tiling: TilingConfig;
    tilesStorage: FsTilesStorageConfig;
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
      required: ['project', 'mode', 'queueName', 'parallelism', 'subtrees', 'jobQueue', 'tiling', 'tilesStorage'],
      properties: {
        project: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string', description: 'Project name', 'x-env-value': 'APP_PROJECT_NAME' },
          },
        },
        mode: {
          enum: ['tiles', 'subtrees'],
          description: 'tiles consumes metatile jobs and writes content, subtrees consumes subtree jobs and writes availability',
          default: 'tiles',
          'x-env-value': 'APP_MODE',
        },
        queueName: { type: 'string', description: 'The metatile job queue name', default: '3dtiler-queue', 'x-env-value': 'QUEUE_NAME' },
        subtrees: {
          type: 'object',
          default: {},
          required: ['queueName'],
          properties: {
            queueName: {
              type: 'string',
              description: 'The subtree job queue name',
              default: '3dtiler-subtrees',
              'x-env-value': 'SUBTREES_QUEUE_NAME',
            },
          },
        },
        parallelism: { type: 'integer', minimum: 1, description: 'Number of parallel jobs', default: 1, 'x-env-value': 'APP_PARALLELISM' },
        jobQueue: {
          type: 'object',
          required: ['waitTimeout', 'pgBoss'],
          properties: {
            waitTimeout: { type: 'integer', description: 'Job queue wait timeout in milliseconds', 'x-env-value': 'QUEUE_WAIT_TIMEOUT' },
            pgBoss: {
              // not the shared db schema: its DB_* environment variables would collide with the ones of the buildings db below
              type: 'object',
              required: ['host', 'port', 'username', 'password', 'database', 'schema', 'ssl', 'healthCheckTimeoutMs'],
              properties: {
                host: { type: 'string', default: 'localhost', 'x-env-value': 'PGBOSS_HOST' },
                port: { type: 'integer', default: 5432, 'x-env-value': 'PGBOSS_PORT' },
                username: { type: 'string', default: 'postgres', 'x-env-value': 'PGBOSS_USERNAME' },
                password: { type: 'string', default: 'postgres', 'x-env-value': 'PGBOSS_PASSWORD' },
                database: { type: 'string', default: 'postgres', 'x-env-value': 'PGBOSS_NAME' },
                schema: { type: 'string', default: 'pgboss', 'x-env-value': 'PGBOSS_SCHEMA' },
                ssl: {
                  type: 'object',
                  default: {},
                  required: ['enabled'],
                  properties: {
                    enabled: { type: 'boolean', default: false, 'x-env-value': 'PGBOSS_ENABLE_SSL_AUTH' },
                    ca: { type: 'string', 'x-env-value': 'PGBOSS_CA_PATH' },
                    cert: { type: 'string', 'x-env-value': 'PGBOSS_CERT_PATH' },
                    key: { type: 'string', 'x-env-value': 'PGBOSS_KEY_PATH' },
                  },
                },
                supervisor: { type: 'boolean', default: true, 'x-env-value': 'PGBOSS_ENABLE_SUPERVISOR' },
                healthCheckTimeoutMs: { type: 'integer', 'x-env-value': 'PGBOSS_HEALTH_CHECK_TIMEOUT_MS' },
              },
            },
          },
        },
        tiling: {
          type: 'object',
          required: ['contentLevels', 'subtreeLevels', 'geometryBuilder', 'rootGeometricError', 'minHeight', 'maxHeight'],
          properties: {
            subtreeLevels: { type: 'integer', minimum: 1, default: 8, description: 'The number of levels in every subtree' },
            geometryBuilder: {
              enum: ['node', 'postgis'],
              default: 'node',
              description: 'Where meshes are built: node triangulates in the worker, postgis uses SFCGAL and ST_TransformPipeline',
              'x-env-value': 'TILING_GEOMETRY_BUILDER',
            },
            rootGeometricError: {
              type: 'number',
              exclusiveMinimum: 0,
              default: 800000,
              description: 'The geometric error of the hemisphere roots, in meters',
            },
            minHeight: { type: 'number', default: -500, description: 'The lowest ellipsoidal height of the content, in meters' },
            maxHeight: { type: 'number', default: 6000, description: 'The highest ellipsoidal height of the content, in meters' },
            contentLevels: {
              type: 'array',
              description: 'The levels that hold content, every building is stored in exactly one tile of one of these levels',
              items: { type: 'integer', minimum: 0 },
              minItems: 1,
              uniqueItems: true,
            },
          },
        },
        tilesStorage: {
          type: 'object',
          required: ['kind', 'basePath'],
          properties: {
            kind: { const: 'fs' },
            basePath: { type: 'string', description: 'The directory the tileset is written to', 'x-env-value': 'TILES_STORAGE_FS_BASE_PATH' },
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

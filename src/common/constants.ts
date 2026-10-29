import { readPackageJsonSync } from '@map-colonies/read-pkg';

export const SERVICE_NAME = readPackageJsonSync().name ?? 'unknown_service';
export const DEFAULT_SERVER_PORT = 80;

export const IGNORED_OUTGOING_TRACE_ROUTES = [/^.*\/v1\/metrics.*$/, /^.*\/v1\/traces.*$/];
export const IGNORED_INCOMING_TRACE_ROUTES = [/^.*\/liveness.*$/, /^.*\/metrics.*$/];

export const ON_SIGNAL = Symbol('onSignal');
export const HEALTHCHECK = Symbol('HealthCheck');

export const JOB_QUEUE_PROVIDER = Symbol('JobQueueProvider');
export const CONSUME_AND_PROCESS_FACTORY = Symbol('ConsumeAndProcessFactory');

export const QUEUE_NAME = Symbol('QueueName');
export const QUEUE_CREATE_OPTIONS = Symbol('QueueCreateOptions');
export const GEOMETRY_BUILDER = Symbol('GeometryBuilder');
export const TILES_STORAGE = Symbol('TilesStorage');
export const SUBTREE_JOB_QUEUE = Symbol('SubtreeJobQueue');
export const QUEUE_EMPTY_TIMEOUT = Symbol('QueueTimeout');
export const METRICS_REGISTRY = Symbol('MetricsRegistry');
export const METRICS_BUCKETS = Symbol('MetricsBuckets');

export const buildApplicationName = (projectName?: string): string =>
  `${SERVICE_NAME}-${projectName ?? 'unknown_env'}-${process.env.NODE_ENV ?? 'unknown_env'}`;

/* eslint-disable @typescript-eslint/naming-convention */
export const SERVICES = {
  LOGGER: Symbol('Logger'),
  CONFIG: Symbol('Config'),
  TRACER: Symbol('Tracer'),
  CLEANUP_REGISTRY: Symbol('CleanupRegistry'),
  PGBOSS: Symbol('Pgboss'),
} satisfies Record<string, symbol>;

export const ExitCodes = {
  SUCCESS: 0,
  GENERAL_ERROR: 1,
} satisfies Record<string, number>;
/* eslint-enable @typescript-eslint/naming-convention */

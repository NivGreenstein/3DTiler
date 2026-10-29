import type { DependencyContainer } from 'tsyringe';
import { Lifecycle, instancePerContainerCachingFactory } from 'tsyringe';
import type { Logger } from '@map-colonies/js-logger';
import { jsLogger } from '@map-colonies/js-logger';
import { getOtelMixin } from '@map-colonies/tracing-utils';
import type { HealthCheck } from '@godaddy/terminus';
import { Registry } from 'prom-client';
import { trace } from '@opentelemetry/api';
import { CleanupRegistry } from '@map-colonies/cleanup-registry';
import type { PgBoss } from 'pg-boss';
import type { DataSource } from 'typeorm';
import {
  CONSUME_AND_PROCESS_FACTORY,
  HEALTHCHECK,
  JOB_QUEUE_PROVIDER,
  METRICS_BUCKETS,
  METRICS_REGISTRY,
  ON_SIGNAL,
  QUEUE_CREATE_OPTIONS,
  QUEUE_EMPTY_TIMEOUT,
  QUEUE_NAME,
  SERVICES,
  SERVICE_NAME,
  GEOMETRY_BUILDER,
  TILES_STORAGE,
  SUBTREE_JOB_QUEUE,
} from '@common/constants';
import { type InjectionObject, registerDependencies } from '@common/dependencyRegistration';
import { getTracing } from '@common/tracing';
import { type ConfigType, getConfig } from '@common/config';
import { DATA_SOURCE_PROVIDER, dataSourceFactory, getDbHealthCheckFunction } from '@common/db';
import { buildingRepositoryFactory, BUILDING_CUSTOM_REPOSITORY_SYMBOL } from './building/DAL/buildingRepository';
import type { JobQueueProvider } from './tiler/interfaces';
import { PgBossJobQueueProvider } from './tiler/jobQueueProvider/pgBossJobQueue';
import { getPgBossHealthCheckFunction, pgBossFactory } from './tiler/jobQueueProvider/pgbossFactory';
import { consumeAndProcessFactory } from './app';
import { NodeGeometryBuilder } from './mesh/geometryBuilder/nodeGeometryBuilder';
import { PostgisGeometryBuilder } from './mesh/geometryBuilder/postgisGeometryBuilder';
import type { GeometryBuilder } from './mesh/geometryBuilder/interfaces';
import { FsTilesStorage } from './tiler/tilesStorage/fsTilesStorage';
import { SUBTREE_QUEUE_POLICY, SubtreeJobQueue } from './tiler/subtrees/subtreeJobQueue';

export interface RegisterOptions {
  override?: InjectionObject<unknown>[];
  useChild?: boolean;
}

export const registerExternalValues = async (options?: RegisterOptions): Promise<DependencyContainer> => {
  const cleanupRegistry = new CleanupRegistry();

  try {
    const dependencies: InjectionObject<unknown>[] = [
      { token: SERVICES.CONFIG, provider: { useValue: getConfig() } },
      {
        token: SERVICES.LOGGER,
        provider: {
          useFactory: instancePerContainerCachingFactory(async (container) => {
            const config = container.resolve<ConfigType>(SERVICES.CONFIG);
            const loggerConfig = config.get('telemetry.logger');
            return jsLogger({ ...loggerConfig, mixin: getOtelMixin() });
          }),
        },
        postInjectionHook: async (deps: DependencyContainer): Promise<void> => {
          const logger = await deps.resolve<Promise<Logger>>(SERVICES.LOGGER);
          deps.register(SERVICES.LOGGER, { useValue: logger });
        },
      },
      {
        token: SERVICES.CLEANUP_REGISTRY,
        provider: { useValue: cleanupRegistry },
        afterAllInjectionHook(container): void {
          const logger = container.resolve<Logger>(SERVICES.LOGGER);
          const cleanupRegistryLogger = logger.child({ subComponent: 'cleanupRegistry' });

          cleanupRegistry.on('itemFailed', (id, error, msg) => cleanupRegistryLogger.error({ msg, itemId: id, err: error }));
          cleanupRegistry.on('itemCompleted', (id) => cleanupRegistryLogger.info({ itemId: id, msg: 'cleanup finished for item' }));
          cleanupRegistry.on('finished', (status) => cleanupRegistryLogger.info({ msg: `cleanup registry finished cleanup`, status }));
        },
      },
      {
        token: SERVICES.TRACER,
        provider: {
          useFactory: instancePerContainerCachingFactory((container) => {
            const tracer = trace.getTracer(SERVICE_NAME);
            const tracing = getTracing();
            const cleanupRegistry = container.resolve<CleanupRegistry>(SERVICES.CLEANUP_REGISTRY);
            cleanupRegistry.register({ func: tracing.stop.bind(tracing), id: SERVICES.TRACER });
            return tracer;
          }),
        },
      },
      {
        token: METRICS_REGISTRY,
        provider: {
          useFactory: instancePerContainerCachingFactory((container) => {
            const config = container.resolve<ConfigType>(SERVICES.CONFIG);

            if (config.get('telemetry.metrics.enabled')) {
              const metricsRegistry = new Registry();
              config.initializeMetrics(metricsRegistry);
              return metricsRegistry;
            }
          }),
        },
      },
      {
        token: METRICS_BUCKETS,
        provider: {
          useFactory: instancePerContainerCachingFactory((container) => {
            const config = container.resolve<ConfigType>(SERVICES.CONFIG);
            return config.get('telemetry.metrics.buckets');
          }),
        },
      },
      {
        token: DATA_SOURCE_PROVIDER,
        provider: { useFactory: instancePerContainerCachingFactory(dataSourceFactory) },
        postInjectionHook: async (deps: DependencyContainer): Promise<void> => {
          const dataSource = deps.resolve<DataSource>(DATA_SOURCE_PROVIDER);
          if (!dataSource.isInitialized) {
            await dataSource.initialize();
            cleanupRegistry.register({ id: DATA_SOURCE_PROVIDER, func: dataSource.destroy.bind(dataSource) });
          }
        },
      },
      { token: BUILDING_CUSTOM_REPOSITORY_SYMBOL, provider: { useFactory: buildingRepositoryFactory } },
      {
        token: GEOMETRY_BUILDER,
        provider: {
          useFactory: instancePerContainerCachingFactory((container) => {
            const config = container.resolve<ConfigType>(SERVICES.CONFIG);
            const builder = config.get('app.tiling.geometryBuilder');
            return builder === 'postgis'
              ? container.resolve<GeometryBuilder>(PostgisGeometryBuilder)
              : container.resolve<GeometryBuilder>(NodeGeometryBuilder);
          }),
        },
      },
      {
        token: TILES_STORAGE,
        provider: {
          useFactory: instancePerContainerCachingFactory((container) => {
            const config = container.resolve<ConfigType>(SERVICES.CONFIG);
            const logger = container.resolve<Logger>(SERVICES.LOGGER);
            return new FsTilesStorage(logger.child({ subComponent: 'tilesStorage' }), config.get('app.tilesStorage.basePath'));
          }),
        },
      },
      {
        token: SERVICES.PGBOSS,
        provider: {
          useFactory: instancePerContainerCachingFactory((container) => {
            const config = container.resolve<ConfigType>(SERVICES.CONFIG);
            const pgBossConfig = config.get('app.jobQueue.pgBoss');
            const projectName = config.get('app.project.name');
            return pgBossFactory({ ...pgBossConfig, projectName });
          }),
        },
      },
      {
        token: QUEUE_NAME,
        provider: {
          useFactory: instancePerContainerCachingFactory((container) => {
            const config = container.resolve<ConfigType>(SERVICES.CONFIG);
            return config.get('app.mode') === 'subtrees' ? config.get('app.subtrees.queueName') : config.get('app.queueName');
          }),
        },
      },
      {
        token: QUEUE_CREATE_OPTIONS,
        provider: {
          useFactory: instancePerContainerCachingFactory((container) => {
            const config = container.resolve<ConfigType>(SERVICES.CONFIG);
            return config.get('app.mode') === 'subtrees' ? { policy: SUBTREE_QUEUE_POLICY } : {};
          }),
        },
      },
      {
        token: QUEUE_EMPTY_TIMEOUT,
        provider: {
          useFactory: instancePerContainerCachingFactory((container) => {
            const config = container.resolve<ConfigType>(SERVICES.CONFIG);
            return config.get('app.jobQueue.waitTimeout');
          }),
        },
      },
      {
        token: JOB_QUEUE_PROVIDER,
        provider: { useClass: PgBossJobQueueProvider },
        options: { lifecycle: Lifecycle.Singleton },
        postInjectionHook: async (deps: DependencyContainer): Promise<void> => {
          const provider = deps.resolve<JobQueueProvider>(JOB_QUEUE_PROVIDER);
          cleanupRegistry.register({ func: provider.stopQueue.bind(provider), id: JOB_QUEUE_PROVIDER });
          await provider.startQueue();
        },
      },
      {
        token: SUBTREE_JOB_QUEUE,
        provider: {
          useFactory: instancePerContainerCachingFactory((container) => {
            const config = container.resolve<ConfigType>(SERVICES.CONFIG);
            const logger = container.resolve<Logger>(SERVICES.LOGGER);
            const pgBoss = container.resolve<PgBoss>(SERVICES.PGBOSS);
            return new SubtreeJobQueue(pgBoss, logger.child({ subComponent: 'subtreeJobQueue' }), config.get('app.subtrees.queueName'));
          }),
        },
        postInjectionHook: async (deps: DependencyContainer): Promise<void> => {
          // pg-boss is started by the job queue provider registration above
          await deps.resolve<SubtreeJobQueue>(SUBTREE_JOB_QUEUE).createQueue();
        },
      },
      { token: CONSUME_AND_PROCESS_FACTORY, provider: { useFactory: consumeAndProcessFactory } },
      {
        token: ON_SIGNAL,
        provider: {
          useFactory: instancePerContainerCachingFactory((container) => {
            const cleanupRegistry = container.resolve<CleanupRegistry>(SERVICES.CLEANUP_REGISTRY);
            return cleanupRegistry.trigger.bind(cleanupRegistry);
          }),
        },
      },
      {
        token: HEALTHCHECK,
        provider: {
          useFactory: (depContainer): HealthCheck => {
            const pgboss = depContainer.resolve<PgBoss>(SERVICES.PGBOSS);
            const dataSource = depContainer.resolve<DataSource>(DATA_SOURCE_PROVIDER);
            const config = depContainer.resolve<ConfigType>(SERVICES.CONFIG);
            const pgBossHealthCheck = getPgBossHealthCheckFunction(pgboss, config.get('app.jobQueue.pgBoss.healthCheckTimeoutMs'));
            const dbHealthCheck = getDbHealthCheckFunction(dataSource, config.get('db.healthCheckTimeoutMs'));
            return async (state): Promise<void> => {
              await Promise.all([pgBossHealthCheck(state), dbHealthCheck(state)]);
            };
          },
        },
      },
    ];

    const container = await registerDependencies(dependencies, options?.override, options?.useChild);
    return container;
  } catch (error) {
    await cleanupRegistry.trigger();
    throw error;
  }
};

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
import {
  CONSUME_AND_PROCESS_FACTORY,
  HEALTHCHECK,
  JOB_QUEUE_PROVIDER,
  METRICS_BUCKETS,
  METRICS_REGISTRY,
  ON_SIGNAL,
  QUEUE_EMPTY_TIMEOUT,
  QUEUE_NAME,
  SERVICES,
  SERVICE_NAME,
} from '@common/constants';
import { type InjectionObject, registerDependencies } from '@common/dependencyRegistration';
import { getTracing } from '@common/tracing';
import { type ConfigType, getConfig } from '@common/config';
import type { JobQueueProvider } from './tiler/interfaces';
import { PgBossJobQueueProvider } from './tiler/jobQueueProvider/pgBossJobQueue';
import { getPgBossHealthCheckFunction, pgBossFactory } from './tiler/jobQueueProvider/pgbossFactory';
import { consumeAndProcessFactory } from './app';

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
            return config.get('app.queueName');
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
            const config = depContainer.resolve<ConfigType>(SERVICES.CONFIG);
            const timeoutMs = config.get('app.jobQueue.pgBoss.healthCheckTimeoutMs');
            return getPgBossHealthCheckFunction(pgboss, timeoutMs);
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

import { setTimeout as setTimeoutPromise } from 'node:timers/promises';
import { Registry } from 'prom-client';
import { jsLogger, type Logger } from '@map-colonies/js-logger';
import type { PgBoss } from 'pg-boss';
import { serializeError } from 'serialize-error';
import { describe, beforeAll, beforeEach, afterEach, it, expect, vi, type Mock } from 'vitest';
import { PgBossJobQueueProvider } from '@src/tiler/jobQueueProvider/pgBossJobQueue';

describe('PgBossJobQueueProvider', () => {
  let provider: PgBossJobQueueProvider;
  let tracerMock: { startActiveSpan: Mock; startSpan: Mock };
  let pgbossMock: Record<'on' | 'start' | 'stop' | 'createQueue' | 'complete' | 'fail' | 'fetch', Mock>;
  let logger: Logger;

  beforeAll(async () => {
    logger = await jsLogger({ enabled: false });
    pgbossMock = {
      on: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      createQueue: vi.fn().mockResolvedValue(undefined),
      complete: vi.fn(),
      fail: vi.fn(),
      fetch: vi.fn(),
    };
  });

  beforeEach(function () {
    tracerMock = {
      startActiveSpan: vi
        .fn()
        .mockImplementation((_name: string, _options: unknown, fn: (span: unknown) => unknown) =>
          fn({ setStatus: vi.fn(), recordException: vi.fn(), end: vi.fn() })
        ),
      startSpan: vi.fn(),
    };
    provider = new PgBossJobQueueProvider(pgbossMock as unknown as PgBoss, logger, tracerMock, 'queue-name', 50, new Registry());
  });

  afterEach(function () {
    vi.clearAllMocks();
    pgbossMock.fetch.mockReset();
  });

  describe('#startQueue', () => {
    it('should start queue provider and create the queue', async () => {
      await expect(provider.startQueue()).resolves.not.toThrow();
      expect(pgbossMock.start).toHaveBeenCalledTimes(1);
      expect(pgbossMock.createQueue).toHaveBeenCalledWith('queue-name');
    });

    it('should throw if trying to start a started queue', async () => {
      await provider.startQueue();

      await expect(provider.startQueue()).rejects.toThrow('queue already running');
    });
  });

  describe('#stopQueue', () => {
    it('should stop the queue provider', async () => {
      await provider.startQueue();

      await expect(provider.stopQueue()).resolves.not.toThrow();
      expect(pgbossMock.stop).toHaveBeenCalledTimes(1);
    });

    it('should resolve if the queue is stopped when it was never started', async () => {
      await expect(provider.stopQueue()).resolves.not.toThrow();
      expect(pgbossMock.stop).not.toHaveBeenCalled();
    });
  });

  describe('#activeQueueName', () => {
    it('should return the queue name', () => {
      expect(provider.activeQueueName).toBe('queue-name');
    });
  });

  describe('#consumeQueue', () => {
    it('should consume the queue and call the provided func', async () => {
      const job1 = [{ id: 'id1', data: { key: 'value' } }];
      const job2 = [{ id: 'id2', data: { key: 'value' } }];

      const fnMock = vi.fn();
      pgbossMock.fetch.mockResolvedValueOnce(job1).mockResolvedValueOnce(job2).mockResolvedValue([]);
      await provider.startQueue();
      const queuePromise = provider.consumeQueue(fnMock);
      await setTimeoutPromise(50);
      await provider.stopQueue();

      await expect(queuePromise).resolves.not.toThrow();

      expect(fnMock).toHaveBeenCalledTimes(2);
      expect(fnMock).toHaveBeenCalledWith({ key: 'value' }, 'id1');
      expect(pgbossMock.complete).toHaveBeenCalledTimes(2);
      expect(pgbossMock.fail).not.toHaveBeenCalled();
    });

    it('should consume the queue in parallel when enabled', async () => {
      const job1 = [{ id: 'id1', data: { key: 'value' } }];
      const job2 = [{ id: 'id2', data: { key: 'value' } }];
      const job3 = [{ id: 'id3', data: { key: 'value' } }];

      const fnMock = vi.fn();
      pgbossMock.fetch.mockResolvedValueOnce(job1).mockResolvedValueOnce(job2).mockResolvedValueOnce(job3).mockResolvedValue([]);

      await provider.startQueue();
      const queuePromise = provider.consumeQueue(fnMock, 2);
      await setTimeoutPromise(50);
      await provider.stopQueue();

      await expect(queuePromise).resolves.not.toThrow();

      expect(fnMock).toHaveBeenCalledTimes(3);
      expect(pgbossMock.complete).toHaveBeenCalledTimes(3);
      expect(pgbossMock.fail).not.toHaveBeenCalled();
    });

    it('should fail the job if the provided function has rejected', async () => {
      const id = 'someId';
      pgbossMock.fetch.mockResolvedValueOnce([{ id }]).mockResolvedValue([]);

      const fetchError = new Error('fetch error');
      const fnMock = vi.fn().mockRejectedValue(fetchError);

      await provider.startQueue();
      const queuePromise = provider.consumeQueue(fnMock);
      await setTimeoutPromise(50);
      await provider.stopQueue();

      await expect(queuePromise).resolves.not.toThrow();

      expect(pgbossMock.complete).not.toHaveBeenCalled();
      expect(pgbossMock.fail).toHaveBeenCalledWith('queue-name', id, serializeError(fetchError));
    });
  });
});

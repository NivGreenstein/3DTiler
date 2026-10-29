export interface JobQueueProvider {
  activeQueueName: string;
  consumeQueue: <T, R = void>(fn: (value: T, jobId?: string) => Promise<R>, parallelism?: number) => Promise<void>;
  startQueue: () => Promise<void>;
  stopQueue: () => Promise<void>;
}

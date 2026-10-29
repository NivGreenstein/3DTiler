import { type Logger } from '@map-colonies/js-logger';
import type { PgBoss } from 'pg-boss';
import type { ImplicitTile } from '@src/tiling/grid';

// The subtree queue uses the stately policy with the subtree as the singleton key, so a subtree has at most one queued and one
// active job: many metatile jobs of the same subtree produce a single rebuild.
const SUBTREE_QUEUE_POLICY = 'stately';

type SubtreeJob = ImplicitTile;

const getSubtreeJobKey = (subtree: SubtreeJob): string => `${subtree.hemisphere}/${subtree.level}/${subtree.x}/${subtree.y}`;

class SubtreeJobQueue {
  public constructor(
    private readonly pgBoss: PgBoss,
    private readonly logger: Logger,
    public readonly queueName: string
  ) {}

  public async createQueue(): Promise<void> {
    await this.pgBoss.createQueue(this.queueName, { policy: SUBTREE_QUEUE_POLICY });
  }

  public async enqueue(subtrees: SubtreeJob[]): Promise<void> {
    for (const subtree of subtrees) {
      const jobId = await this.pgBoss.send(this.queueName, subtree, { singletonKey: getSubtreeJobKey(subtree) });
      this.logger.debug({ msg: jobId === null ? 'subtree job already queued' : 'subtree job queued', subtree, jobId });
    }
  }
}

export { SubtreeJobQueue, SUBTREE_QUEUE_POLICY, getSubtreeJobKey };
export type { SubtreeJob };

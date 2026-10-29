// The job shape produced by metatile-queue-populator
export interface MetatileJob {
  z: number;
  x: number;
  y: number;
  metatile: number;
  parent?: string;
  state?: number;
  force?: boolean;
}

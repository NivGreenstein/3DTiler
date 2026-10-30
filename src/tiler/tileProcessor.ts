import { Counter, Histogram, type Registry } from 'prom-client';
import { type Logger } from '@map-colonies/js-logger';
import { inject, injectable } from 'tsyringe';
import { type Attributes, type Span, SpanStatusCode, type Tracer } from '@opentelemetry/api';
import { GEOMETRY_BUILDER, METRICS_BUCKETS, METRICS_REGISTRY, SERVICES, SUBTREE_JOB_QUEUE, TILES_STORAGE } from '@common/constants';
import type { ConfigType } from '@common/config';
import type { TilingConfig } from '@common/configSchema';
import { jobAttributes, spanName } from '@common/tracing/job';
import { writeGlb } from '@src/glb/glbWriter';
import type { GeometryBuilder } from '@src/mesh/geometryBuilder/interfaces';
import { getTileFrame } from '@src/mesh/geometryBuilder/tileFrame';
import { getContentNodeMatrix } from '@src/tiling/enu';
import { getDescendantsAtLevel, getSubtreeRootsOfArea, gridToImplicit, metatileToGridTile, type GridTile } from '@src/tiling/grid';
import { getContentKey } from '@src/tiling/layout';
import type { TilesStorage } from './tilesStorage/interfaces';
import type { SubtreeJobQueue } from './subtrees/subtreeJobQueue';
import type { MetatileJob } from './types';

const GLB_CONTENT_TYPE = 'model/gltf-binary';

enum ContentTileStatus {
  STORED = 'stored',
  EMPTY = 'empty',
}

interface MetatileResult {
  stored: number;
  empty: number;
}

@injectable()
export class TileProcessor {
  private readonly tiling: TilingConfig;
  private readonly contentTilesCounter?: Counter<'status' | 'z'>;
  private readonly durationHistogram?: Histogram<'kind' | 'z'>;

  public constructor(
    @inject(SERVICES.LOGGER) private readonly logger: Logger,
    @inject(SERVICES.TRACER) private readonly tracer: Tracer,
    @inject(SERVICES.CONFIG) config: ConfigType,
    @inject(GEOMETRY_BUILDER) private readonly geometryBuilder: GeometryBuilder,
    @inject(TILES_STORAGE) private readonly tilesStorage: TilesStorage,
    @inject(SUBTREE_JOB_QUEUE) private readonly subtreeJobQueue: SubtreeJobQueue,
    @inject(METRICS_REGISTRY) registry?: Registry,
    @inject(METRICS_BUCKETS) metricsBuckets?: number[]
  ) {
    this.tiling = config.get('app.tiling');

    if (registry !== undefined) {
      this.contentTilesCounter = new Counter({
        name: 'tiler3d_content_tiles_count',
        help: 'The number of content tiles processed, by status',
        labelNames: ['status', 'z'] as const,
        registers: [registry],
      });
      this.durationHistogram = new Histogram({
        name: 'tiler3d_action_duration_seconds',
        help: 'The duration of building, encoding and storing a content tile',
        labelNames: ['kind', 'z'] as const,
        buckets: metricsBuckets,
        registers: [registry],
      });
    }
  }

  /**
   * Builds every content tile inside the metatile, stores the non empty ones, deletes the empty ones, and queues the rebuild of the
   * subtrees that hold them.
   */
  public async processMetatile(job: MetatileJob): Promise<MetatileResult> {
    const area = metatileToGridTile(job);
    const attributes = {
      [jobAttributes.TILE_Z]: job.z,
      [jobAttributes.TILE_X]: job.x,
      [jobAttributes.TILE_Y]: job.y,
      [jobAttributes.TILE_METATILE]: job.metatile,
    };

    return this.withSpan(spanName.METATILE_PROCESS, attributes, async () => {
      const result: MetatileResult = { stored: 0, empty: 0 };
      for (const level of this.tiling.contentLevels) {
        for (const tile of getDescendantsAtLevel(area, level)) {
          const status = await this.processContentTile(tile);
          result[status === ContentTileStatus.STORED ? 'stored' : 'empty']++;
        }
      }

      const deepestLevel = Math.max(...this.tiling.contentLevels);
      await this.subtreeJobQueue.enqueue(getSubtreeRootsOfArea(area, deepestLevel, this.tiling.subtreeLevels));

      this.logger.info({ msg: 'metatile processed', job, area, ...result });
      return result;
    });
  }

  private async processContentTile(tile: GridTile): Promise<ContentTileStatus> {
    const attributes = { [jobAttributes.TILE_Z]: tile.z, [jobAttributes.TILE_X]: tile.x, [jobAttributes.TILE_Y]: tile.y };

    return this.withSpan(spanName.CONTENT_TILE_PROCESS, attributes, async (span) => {
      const key = getContentKey(gridToImplicit(tile));
      const frame = getTileFrame(tile);

      const endBuild = this.durationHistogram?.startTimer({ kind: 'build', z: tile.z });
      const content = await this.geometryBuilder.buildTile(tile, frame);
      endBuild?.();

      if (content === undefined) {
        await this.tilesStorage.delete([key]);
        this.contentTilesCounter?.inc({ status: ContentTileStatus.EMPTY, z: tile.z });
        span.setAttribute(jobAttributes.TILE_STATUS, ContentTileStatus.EMPTY);
        return ContentTileStatus.EMPTY;
      }

      const endEncode = this.durationHistogram?.startTimer({ kind: 'encode', z: tile.z });
      const glb = writeGlb({ mesh: content.mesh, features: content.features, nodeMatrix: getContentNodeMatrix(frame.enu) });
      endEncode?.();

      const endStore = this.durationHistogram?.startTimer({ kind: 'store', z: tile.z });
      await this.tilesStorage.put(key, glb, GLB_CONTENT_TYPE);
      endStore?.();

      this.logger.debug({
        msg: 'content tile stored',
        tile,
        key,
        features: content.features.length,
        triangles: content.mesh.triangleCount,
        bytes: glb.byteLength,
      });
      this.contentTilesCounter?.inc({ status: ContentTileStatus.STORED, z: tile.z });
      span.setAttributes({ [jobAttributes.TILE_STATUS]: ContentTileStatus.STORED, [jobAttributes.TILE_FEATURES]: content.features.length });
      return ContentTileStatus.STORED;
    });
  }

  private async withSpan<T>(name: string, attributes: Attributes, fn: (span: Span) => Promise<T>): Promise<T> {
    return this.tracer.startActiveSpan(name, { attributes }, async (span) => {
      try {
        const result = await fn(span);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        if (error instanceof Error) {
          span.recordException(error);
        }
        throw error;
      } finally {
        span.end();
      }
    });
  }
}

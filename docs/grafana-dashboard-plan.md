# Grafana dashboard plan

A Grafana dashboard for 3DTiler, in the same style as retiler's `dashboards/instance.json`, that answers:

- Is the pipeline moving, and how big is the backlog?
- What fails?
- Where does the time go?
- Are the tiles within the size budget?

It is milestone M8's dashboard item in the [execution plan](./execution-plan.md).

## 1. Starting point

What `/metrics` exports today:

| Metric                                     | Type      | Labels                                   | From                                  |
| ------------------------------------------ | --------- | ---------------------------------------- | ------------------------------------- |
| `tiler3d_current_running_job_count`        | gauge     |                                          | `PgBossJobQueueProvider` (both modes) |
| `tiler3d_content_tiles_count`              | counter   | `status` (`stored`, `empty`), `z`        | `TileProcessor`                       |
| `tiler3d_action_duration_seconds`          | histogram | `kind` (`build`, `encode`, `store`), `z` | `TileProcessor`                       |
| `config_time_of_last_fetch_unix_timestamp` | gauge     |                                          | `@map-colonies/config`                |
| `process_*`, `nodejs_*`                    | default   |                                          | `@map-colonies/prometheus`            |

The `/metrics` middleware adds `project` (`app.project.name`) to every series, and Prometheus adds `job` and `instance`.

What is missing for a useful dashboard:

- **Jobs:** nothing counts completed and failed metatile jobs, or how long a whole job takes.
- **Subtree worker:** it exports no metrics of its own.
- **Queue backlog:** nothing reports how many jobs are waiting or failed in the two pg-boss queues.
- **Tile size:** nothing measures GLB size or features per tile, so the 1–2 MB budget can't be watched.
- **Mode:** nothing tells a tile worker from a subtree worker, or the `node` builder from the `postgis` one, so the panels can't be split by them.
- **Skipped faces:** degenerate faces are skipped without a trace.

## 2. Metrics to add (step 1)

All new metrics use the `tiler3d_` prefix, the `METRICS_REGISTRY` / `METRICS_BUCKETS` injection retiler uses, and stay off when `telemetry.metrics.enabled` is false.

| Metric                              | Type                       | Labels                                            | Where                               | Notes                                                                                                                        |
| ----------------------------------- | -------------------------- | ------------------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `tiler3d_info`                      | gauge, always 1            | `mode`, `geometry_builder`, `version`             | `containerConfig`                   | Lets panels filter by mode with `* on(instance) group_left(mode) tiler3d_info`.                                              |
| `tiler3d_metatiles_count`           | counter                    | `status` (`completed`, `failed`)                  | `app.ts` around `processMetatile`   | Job level counts, like `retiler_tiles_count`.                                                                                |
| `tiler3d_metatile_duration_seconds` | histogram                  |                                                   | `TileProcessor.processMetatile`     | The whole job, including the subtree enqueue.                                                                                |
| `tiler3d_action_duration_seconds`   | histogram                  | add `kind="query"` and `kind="mesh"`              | geometry builders                   | Splits `build` into the database time and the triangulation time, to compare `node` with `postgis`.                          |
| `tiler3d_content_tile_bytes`        | histogram                  | `z`                                               | `TileProcessor`                     | Buckets 64 KB to 4 MB. Watches the 1–2 MB budget.                                                                            |
| `tiler3d_content_tile_features`     | histogram                  | `z`                                               | `TileProcessor`                     | Buildings per tile.                                                                                                          |
| `tiler3d_skipped_faces_count`       | counter                    | `geometry_builder`                                | both geometry builders              | Degenerate faces (node) and faces SFCGAL rejects (postgis).                                                                  |
| `tiler3d_subtrees_count`            | counter                    | `status` (`stored`, `deleted`, `failed`), `level` | `SubtreeProcessor`                  | `level` is 0 for hemisphere roots and 8 for the rest. Low cardinality.                                                       |
| `tiler3d_subtree_duration_seconds`  | histogram                  | `level`                                           | `SubtreeProcessor`                  | The hemisphere roots scan the whole index, so this is the scaling signal.                                                    |
| `tiler3d_queue_jobs`                | gauge, collected on scrape | `queue`, `state` (`queued`, `active`, `failed`)   | a collector on the pg-boss instance | Reads `pgBoss.getQueue(name)` for both queues. Every worker reports the same numbers, so panels use `max by (queue, state)`. |

`z`, `kind`, `status`, `level` and `queue` all have a handful of values, so cardinality stays small. Tile coordinates and building ids never become labels.

**Done when:** unit tests check that each metric is registered and incremented (as the existing processor tests do with a `Registry`), and a compose run shows every series on `/metrics`.

## 3. The dashboard (step 2)

File `dashboards/instance.json` (the retiler path), Grafana schema 37 or later, no hard-coded datasource UID.

### Variables

| Variable     | Query                                                  | Notes                                        |
| ------------ | ------------------------------------------------------ | -------------------------------------------- |
| `datasource` | type `prometheus`                                      | So the same JSON works in every environment. |
| `project`    | `label_values(tiler3d_info, project)`                  |                                              |
| `instance`   | `label_values(tiler3d_info{project="$project"}, job)`  | multi, include all                           |
| `mode`       | `label_values(tiler3d_info{project="$project"}, mode)` | multi, include all                           |
| `interval`   | `1m,10m,30m,1h,6h,12h,1d`                              | As in retiler, for the "in window" panels.   |

In the queries below, `$sel` stands for `project="$project", job=~"$instance"`.

### Row 1: Overview (stat panels)

| Panel               | Query                                                                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Metatiles completed | `sum(increase(tiler3d_metatiles_count{$sel, status="completed"}[$__range]))`                                                               |
| Metatiles failed    | `sum(increase(tiler3d_metatiles_count{$sel, status="failed"}[$__range]))`, red when above 0                                                |
| Metatile backlog    | `max(tiler3d_queue_jobs{project="$project", queue="3dtiler-queue", state="queued"})`                                                       |
| Subtree backlog     | `max(tiler3d_queue_jobs{project="$project", queue="3dtiler-subtrees", state="queued"})`                                                    |
| Running jobs        | `sum(tiler3d_current_running_job_count{$sel})`                                                                                             |
| Largest tile (p99)  | `histogram_quantile(0.99, sum by (le) (rate(tiler3d_content_tile_bytes_bucket{$sel}[$__rate_interval])))`, yellow from 1 MB, red from 2 MB |

### Row 2: Throughput (time series)

- Metatiles per minute by status: `sum by (status) (rate(tiler3d_metatiles_count{$sel}[$__rate_interval])) * 60`
- Content tiles in the `$interval` window, by status and level: `sum by (status, z) (increase(tiler3d_content_tiles_count{$sel}[$interval]))`
- Queue depth over time, both queues, `queued` and `failed`: `max by (queue, state) (tiler3d_queue_jobs{project="$project"})`

### Row 3: Latency (time series, p50 / p90 / average, like retiler)

- Metatile duration: from `tiler3d_metatile_duration_seconds`.
- Duration by step: one panel per `kind` (`query`, `mesh`, `encode`, `store`), e.g. `histogram_quantile(0.9, sum by (le) (rate(tiler3d_action_duration_seconds_bucket{$sel, kind="query"}[$__rate_interval])))`.
- Query and mesh time by geometry builder: the same queries joined with `tiler3d_info` and grouped by `geometry_builder`. This compares `node` with `postgis` in production.

### Row 4: Tile content

- Tile size p50 / p90 / p99 by level from `tiler3d_content_tile_bytes`, with 1 MB and 2 MB threshold lines.
- Features per tile p50 / p90 from `tiler3d_content_tile_features`.
- Skipped faces per minute by builder: `sum by (geometry_builder) (rate(tiler3d_skipped_faces_count{$sel}[$__rate_interval])) * 60`

### Row 5: Subtrees

- Subtrees per minute by status and level, from `tiler3d_subtrees_count`.
- Subtree duration p90 by level, from `tiler3d_subtree_duration_seconds`. A growing level 0 line means the hemisphere root scan needs the `content_tiles` table (execution plan, M7).

### Row 6: System (collapsed, copied from retiler)

- Process CPU, process memory and heap, and event loop lag from the default `process_*` / `nodejs_*` metrics.
- Config last fetch time.

## 4. Alerts (step 3, optional)

As Grafana alert rules in the same folder. Thresholds are starting points:

| Alert                 | Condition                                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------------ |
| Metatile jobs failing | `sum(increase(tiler3d_metatiles_count{status="failed"}[15m])) > 0`                                     |
| Backlog not draining  | metatile `queued` above 0 and `rate(tiler3d_metatiles_count{status="completed"}[15m]) == 0` for 15 min |
| Tiles over budget     | tile size p99 above 2 MB for 30 min                                                                    |
| Worker down           | `up{job=~"3dtiler.*"} == 0` for 5 min                                                                  |

## 5. Local stack and delivery (step 4)

- **Compose profile `monitoring`:** Prometheus scrapes `tiler-tiles` and `tiler-subtrees` on `:8080/metrics`. Grafana has a provisioned Prometheus datasource and loads `dashboards/instance.json`. Both are pinned images, and Grafana is published on `GRAFANA_PORT`.
- **Helm:** the chart already has the `mclabels.prometheus.enabled` annotation from the boilerplate. Check that it covers both deployments (tiles and subtrees) once M8 splits them.
- **Check:** run `docker compose --profile monitoring --profile footprints up` on the Tel Aviv data, and confirm that every panel has data and no query errors in Grafana's query inspector. Screenshot the dashboard in headless Chromium, as with the viewer, and add it to the README.

## 6. Order of work

1. Add the metrics in §2, with unit tests. One PR.
2. Write `dashboards/instance.json` and the compose `monitoring` profile, and check them on the Tel Aviv data. One PR.
3. Add the alert rules, and document the dashboard in the README.

## 7. Open questions

- **Grafana version:** what does MapColonies run? It decides the JSON schema version and whether the alerts are Grafana-managed or Prometheus rules.
- **Labels:** do your Prometheus scrape configs add `namespace` or `pod`? If so, the `instance` variable should use them instead of `job`.
- **Shared dashboard:** should it go to a shared dashboards repository, or stay in this repo as retiler's does?

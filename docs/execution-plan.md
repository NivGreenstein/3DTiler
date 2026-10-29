# 3DTiler execution plan

PostGIS buildings → 3D Tiles 1.1 (implicit quadtree, GLB content) → S3 → Cesium.

This plan turns the [design plan](./osm-3d-tiles-plan.md) into milestones. It is based on:

- **retiler**: the worker shape (pg-boss consumer, `TileProcessor`, storage providers, liveness and metrics only, no REST API).
- **osm-sync-tracker**: the DB layer (TypeORM `DataSource` factory, `dataSource.getRepository(X).extend({...})` custom repositories, registered in tsyringe by symbol).
- **pg2b3dm**: the 3D Tiles output (implicit tiling, subtree files, `EXT_mesh_features` and `EXT_structural_metadata`, triangulating footprints in code).

---

## 1. Changes to the design plan

Things found while reading the references that change the design.

### 1.1 Use two hemisphere roots so the grid matches WorldCRS84Quad (recommended)

The design uses one 360°×180° implicit root. Its tiles are 2:1 rectangles, and its indices don't match the grid that retiler and metatile-queue-populator use (`TILEGRID_WORLD_CRS84`, which has 2 tiles at z0).

Instead, write an explicit root `tileset.json` with no content and **two children**, west and east. Each child is a 180°×180° implicit quadtree. Then:

- implicit level `L` = CRS84Quad zoom `L`, and tiles are square in degrees
- `hemisphere = x >> L` and `localX = x & (2^L − 1)`. y uses the same numbering (implicit tiling counts y from the south, retiler counts from the north, so flip it)
- jobs from metatile-queue-populator, and `@map-colonies/tile-calc`, work without changes

The content URIs differ only by prefix: `content/{h}/{level}/{x}/{y}.glb` and `subtrees/{h}/{level}/{x}/{y}.subtree`, where `h` is `0` or `1` and is written into each child's URI template.

**Side effect:** tiles are half as wide as in the design at the same level. A CRS84Quad z15 tile is about 0.6×0.6 km at the equator. We either keep z14/z15 as content levels (smaller tiles, which helps the dense-tile size target) or move them to z13/z14. This is a tuning setting.

### 1.2 Build the geometry in Node, not in SQL (recommended)

The design runs `CG_Extrude`, `CG_Tesselate` and `ST_TransformPipeline` per row. That requires SFCGAL, which managed or Crunchy PostGIS images often don't ship, plus PostGIS 3.4 or later. It also builds a PROJ pipeline string per row, which PostGIS does not cache, and it spends CPU on the database that osm2pgsql and pg-boss also use.

pg2b3dm triangulates in code. We do the same:

- **SQL** returns only: `osm_id`, footprint WKB (4326), `height`, `min_height`, base elevation, the tile columns, and attributes.
- **Node** does geodetic → ECEF → ENU in float64, builds walls as quads, triangulates roofs and floors with `earcut`, and computes flat normals.

This is about 200 lines of pure, unit-testable code. Workers scale horizontally and the database does index lookups only. The SQL path can come back later behind a `geometryBuilder: 'sql' | 'node'` setting if we want it.

### 1.3 Smaller fixes

| Item                        | Change                                                                                                                                                                                                                                         |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Root region height          | **−200 m is too high for Israel.** The Dead Sea shore is at about −430 m orthometric. Use about **−500 m to 6000 m**.                                                                                                                          |
| Metatile columns            | Derive them from the tile indices: `meta_x = tile_x >> (tile_z − metaZ)`. Computing them from the centroid separately can put a building at a tile edge into a different metatile than its tile.                                               |
| Base elevation              | Store one **scalar** column (`base_h`, ellipsoidal). Don't store it as Z on the footprint. A footprint with varying Z gives tilted roofs. The DEM **must match the terrain the Cesium client uses**, or buildings will float or sink.          |
| Winding / culling           | Force CCW outer rings and CW holes. Start with `doubleSided: true` (pg2b3dm's default) and switch it off once winding is verified.                                                                                                             |
| `osm_id` in metadata        | OSM ids are larger than uint32, so use `INT64` in the property table. Negative ids from osm2pgsql relations need a signed type.                                                                                                                |
| Cesium dependency           | Don't add `cesium` as a runtime dependency just for one matrix. Write the ENU→ECEF matrix ourselves (about 20 lines), and use `cesium` as a **devDependency** only to check it in tests.                                                       |
| Content outside tile bounds | A building whose centroid is in a tile can stick out past the tile's region. This is acceptable for the MVP because buildings are small next to the tile. If culling pops at edges, add `TILE_BOUNDING_REGION` metadata to the subtrees later. |
| Empty tiles                 | When an update leaves a tile empty, **delete** its GLB and clear its availability (the same as retiler's `deleteBlankTiles`).                                                                                                                  |

### 1.4 GLB node transform (confirming the design)

Positions are ENU, with z up. Cesium applies Y-up→Z-up to all glTF content, so the root node matrix is `Z_UP_TO_Y_UP × ENU_TO_ECEF(center)`. The two axis swaps cancel, and the final position is `ENU_TO_ECEF × p`. Each GLB contains everything it needs to be placed, which implicit tiling requires.

---

## 2. Target architecture of the repo

The service is a worker in retiler's style. HTTP is used only for `/liveness` and `/metrics`. The boilerplate's `resourceName/`, `anotherResource/`, OpenAPI router and `serverBuilder` are removed.

```
src/
  index.ts                     # liveness + metrics server, then consumeAndProcess()  (retiler)
  app.ts                       # consumeAndProcessFactory                              (retiler)
  containerConfig.ts           # tsyringe registrations, CleanupRegistry, postInjectionHook
  common/
    config.ts constants.ts dependencyRegistration.ts (+ postInjectionHook) tracing.ts metrics.ts util.ts
    db/index.ts                # createDataSourceOptions / getCachedDataSource / dataSourceFactory / health  (osm-sync-tracker)
  building/
    DAL/building.ts            # TypeORM entity mapped onto the osm2pgsql table (read only, synchronize: false)
    DAL/buildingRepository.ts  # createBuildingRepository(ds).extend({ findByMetatile, findContentTilesInSubtree })
    models/building.ts         # domain types (BuildingRecord, ...)
  tiling/
    grid.ts                    # CRS84Quad <-> implicit (hemisphere, level, x, y), bounds, children, metatile -> content tiles
    enu.ts                     # geodetic->ECEF, ENU frame, node matrix
    tileset.ts                 # static root tileset.json builder
    subtree.ts                 # binary .subtree writer (availability bitstreams / constants)
  mesh/
    footprint.ts               # WKB -> rings, ring orientation
    extruder.ts                # walls + earcut roof/floor in ENU, normals, feature ids
  glb/
    extensions/                # EXT_mesh_features, EXT_structural_metadata (gltf-transform Extension classes)
    glbEncoder.ts              # @gltf-transform/core document -> meshopt -> GLB bytes
  tiler/
    interfaces.ts types.ts
    jobQueueProvider/          # pgBossJobQueue.ts, pgbossFactory.ts   (ported from retiler)
    tilesStorageProvider/      # s3.ts, fs.ts, factory.ts              (ported, + ContentType, + .subtree/.json)
    tileProcessor.ts           # one metatile job end to end
    subtreeProcessor.ts        # one subtree job end to end
```

### 2.1 DB layer in the osm-sync-tracker style

```ts
// building/DAL/buildingRepository.ts
const createBuildingRepository = (dataSource: DataSource) => {
  return dataSource.getRepository(BuildingDb).extend({
    async findByMetatile(metaZ: number, metaX: number, metaY: number): Promise<BuildingRecord[]> {
      return this.createQueryBuilder('b')
        .select(['b.osmId', 'b.height', 'b.minHeight', 'b.baseH', 'b.tileZ', 'b.tileX', 'b.tileY'])
        .addSelect('ST_AsBinary(b.geom)', 'wkb')
        .where('b.meta_x = :metaX AND b.meta_y = :metaY', { metaX, metaY })
        .getRawMany();
    },
    async findContentTilesInSubtree(/* subtree root */): Promise<TileIndex[]> {
      /* SELECT DISTINCT tile_z, tile_x, tile_y ... */
    },
  });
};
export type BuildingRepository = ReturnType<typeof createBuildingRepository>;
export const buildingRepositoryFactory: FactoryFunction<BuildingRepository> = (c) =>
  createBuildingRepository(c.resolve<DataSource>(DATA_SOURCE_PROVIDER));
export const BUILDING_CUSTOM_REPOSITORY_SYMBOL = Symbol('BUILDING_CUSTOM_REPOSITORY_SYMBOL');
```

The table and schema names come from config, and the entity is never synchronized because osm2pgsql owns the table. The pg-boss pool and the TypeORM pool are separate, as in the two reference repos. They can point at different databases.

### 2.2 Job flow (TileProcessor)

```
pg-boss job {z, x, y, metatile, parent, state, force}   // metatile-queue-populator shape
  → grid: metatile → content tiles (e.g. 4×z14 + 16×z15)
  → repo.findByMetatile()                  // 1 query, index (meta_x, meta_y)
  → group rows by (tile_z, tile_x, tile_y)
  → per tile: ENU frame at tile center → extrude → GLB (+features, +metadata, meshopt)
  → store non-empty tiles, delete content tiles that are now empty
  → enqueue subtree job (singletonKey = subtree id) so availability is rebuilt once per batch
```

Subtree jobs run on a **separate pg-boss queue**. The same image runs them with `app.mode = 'tiles' | 'subtrees'`. A z13 metatile belongs to exactly one level-8 subtree, so workers never write the same subtree concurrently. The root subtree (levels 0–7) is rebuilt only when a level-8 subtree changes between empty and non-empty.

---

## 3. Milestones (each one is a PR)

### M0: Decisions and data contract _(blocks M2)_

- [ ] Resolve the open questions in §4.
- [ ] Freeze the `buildings` table contract: columns, types, SRID, indexes.
- [ ] Get or register a config schema in `@map-colonies/schemas` (see §4).

### M1: Worker skeleton

- [ ] Remove the boilerplate REST resources, OpenAPI router and `serverBuilder`. Keep vitest, eslint, prettier, husky, Dockerfile and helm.
- [ ] Port from retiler: `index.ts` (terminus liveness, `/metrics`), `CleanupRegistry`, `ON_SIGNAL`, and `postInjectionHook` / `afterAllInjectionHook` in `dependencyRegistration.ts`.
- [ ] Port `PgBossJobQueueProvider` and `pgbossFactory` (pg-boss 12) with their unit tests, converted from jest to vitest.
- [ ] Config: `app.queueName`, `app.parallelism`, `app.jobQueue.pgBoss.*`, `db.*`, `app.tiling.*`, `app.tilesStorage.*`.
- **Done when:** the worker starts, consumes a dummy queue, and shuts down gracefully.

### M2: DB layer

- [ ] `common/db/index.ts` in the osm-sync-tracker style: SSL from files, cached `DataSource`, health check (included in liveness together with pg-boss).
- [ ] `building` entity and `BuildingRepository` with `findByMetatile` and `findContentTilesInSubtree`.
- [ ] Integration tests against a PostGIS container with fixture buildings (a few Tel Aviv blocks, one with a hole, one multipolygon, one crossing a tile edge).
- **Done when:** the repository returns the expected rows for a metatile, and `EXPLAIN` shows an index scan.

### M3: Tiling math _(pure, can run in parallel with M2)_

- [ ] `grid.ts`: hemisphere mapping, y flip, tile bounds in radians, `metatileToContentTiles`, `contentTileToSubtree`.
- [ ] `enu.ts`: WGS84 geodetic→ECEF, ENU basis, column-major node matrix including Z_UP_TO_Y_UP.
- [ ] Tests: compare against `cesium` (devDependency) `Cartesian3.fromDegrees`, `Transforms.eastNorthUpToFixedFrame` and `Axis.Z_UP_TO_Y_UP` to within 1e-6.

### M4: Mesh builder

- [ ] WKB parsing (`wkx`, or a small reader for Polygon and MultiPolygon only), ring orientation.
- [ ] Extrusion in ENU, from `base_h + min_height` to `base_h + height`: walls as quads with flat normals, and roof and floor with `earcut` (holes supported).
- [ ] A per-vertex `_FEATURE_ID_0`.
- [ ] Tests: vertex and triangle counts, normals pointing outward, a closed solid, a polygon with a hole.

### M5: GLB encoder

- [ ] `@gltf-transform/core` document: one primitive per tile, positions as float32 ENU, normals, feature ids, one material.
- [ ] `EXT_mesh_features` and `EXT_structural_metadata` as gltf-transform `Extension` classes. First check whether the classes in CesiumGS `3d-tiles-tools` can be reused (Apache-2.0). Otherwise write about 150 lines.
- [ ] `EXT_meshopt_compression` with `KHR_mesh_quantization` (`meshoptimizer` package). Draco is optional, behind a setting.
- [ ] Tests: `gltf-validator` passes with no errors, and the output decodes back to the same feature count.

### M6: End-to-end tile job (the design's **Phase 2 gate**)

- [ ] Port the storage providers (S3 and FS). Add `ContentType` (`model/gltf-binary`, `application/octet-stream` for `.subtree`, `application/json`) and a layout template per artifact type.
- [ ] `TileProcessor.processMetatile` with tracing spans, metrics (`3dtiler_tiles_count`, duration histogram by kind `query|mesh|encode|store|delete`), and empty-tile deletion.
- [ ] A one-off command that writes the static `tileset.json` (§1.1).
- [ ] A dev script that enqueues the Tel Aviv metatiles.
- **Gate:** `npx 3d-tiles-validator` passes, Tel Aviv renders correctly in Cesium (one known building checked against Cesium's position), and a z15 tile is at most 1–2 MB.

### M7: Subtrees and availability

- [ ] `subtree.ts` binary writer: header, JSON, bitstreams, with `constant` used when a bitstream is all 0 or all 1.
- [ ] Rule: tile availability is the content tiles plus all of their ancestors (needed for ADD traversal). Child subtree availability is set at the last level.
- [ ] `SubtreeProcessor` job (`app.mode = 'subtrees'`), enqueued from tile jobs with a `singletonKey`.
- [ ] Tests: round-trip through `3d-tiles-tools` subtree reading, and the validator passes on a generated tileset.

### M8: Ops

- [ ] Helm: two deployments (tiles and subtrees) from one chart, with values for both queues, the DB, S3 and SSL secrets.
- [ ] S3 bucket CORS and MIME types documented.
- [ ] Grafana dashboard based on `retiler/dashboards/instance.json`.
- [ ] README: running locally (`docker compose` with PostGIS and MinIO), config reference.

### Parallel track D: Data (osm2pgsql flex)

- [ ] Flex Lua style for `buildings`: `height` from the `height` tag, else `building:levels × 3 m`, else a default; `min_height`; tile and metatile columns computed in Lua from the centroid using the same grid as `grid.ts` (shared test vectors); index `(meta_x, meta_y)`.
- [ ] Base elevation: a DEM raster table (`postgis_raster`) plus geoid, filled by an insert/update trigger, or sampled at render time. **Decision needed (§4).**
- [ ] Expiry: work out what metatile-queue-populator expects. osm2pgsql expiry outputs EPSG:3857 tiles, and these must be turned into CRS84Quad metatiles. A building that moves expires both its old and new metatiles.

### Later

- Detiler integration (skip tiles that are already up to date, cooldowns), in the same pattern as retiler.
- A z16 content level for dense areas, and `TILE_BOUNDING_REGION` subtree metadata.
- An OGC API – Features service for picking and identifying features.

---

## 4. Open questions

1. **Grid:** two hemisphere roots aligned with CRS84Quad (§1.1, recommended), or the design's single 360×180 root?
2. **Geometry:** built in Node (§1.2, recommended), or SFCGAL in SQL? Is SFCGAL even available on the target PostGIS?
3. **Config schema:** retiler uses `vectorRetilerV3` from `@map-colonies/schemas`. Do we add a `3dtiler/v1` schema to that repo, or start with offline mode and a local schema?
4. **Source table:** do you already have a `buildings` table, and with which columns and SRID? Or is the osm2pgsql flex style part of this work?
5. **DEM and terrain:** which terrain does the Cesium client use, so that `base_h` is sampled from the same DEM?
6. **Queue producer:** do we reuse metatile-queue-populator as is (its job shape and its expiry input format), or write our own enqueue script for the MVP?
7. **Content levels:** z14/z15 with the halved CRS84Quad tiles, or z13/z14?

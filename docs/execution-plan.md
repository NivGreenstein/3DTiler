# 3DTiler execution plan

PostGIS buildings → 3D Tiles 1.1 (implicit quadtree, GLB content) → S3 → Cesium.

This plan turns the [design plan](./osm-3d-tiles-plan.md) into milestones. It is based on:

- **retiler**: the worker shape (pg-boss consumer, `TileProcessor`, storage providers, liveness and metrics only, no REST API).
- **osm-sync-tracker**: the DB layer (TypeORM `DataSource` factory, `dataSource.getRepository(X).extend({...})` custom repositories, registered in tsyringe by symbol).
- **pg2b3dm**: the 3D Tiles output (implicit tiling, subtree files, `EXT_mesh_features` and `EXT_structural_metadata`, triangulating footprints in code).

## Status

M1 to M7 work end to end with `docker compose up` (see the [README](../README.md)), on two sources:

- **3DBAG** (LoD 2.2, EPSG:7415, converted to EPSG:4326).
- **2D footprints in EPSG:4326**, e.g. 31,281 Tel Aviv buildings from Overture Maps, extruded at import (`scripts/footprints`).

The output passes `3d-tiles-validator` with no errors or warnings, renders in Cesium, and building properties can be picked. The densest Tel Aviv z15 tile is 0.94 MB uncompressed, which meets the design's Tel Aviv gate. Left: S3 storage, meshopt compression, Helm, per-building ground heights from a DEM, and the OSM source.

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

### 1.2 Build the geometry in Node, not in SQL (decided, with a PostGIS option)

The design runs `CG_Extrude`, `CG_Tesselate` and `ST_TransformPipeline` per row. That requires SFCGAL, which managed or Crunchy PostGIS images often don't ship, plus PostGIS 3.4 or later. It also builds a PROJ pipeline string per row, which PostGIS does not cache, and it spends CPU on the database that osm2pgsql and pg-boss also use.

pg2b3dm triangulates in code. We do the same:

- **SQL** returns only plain rows for the metatile: the id, the geometry as WKB in EPSG:4979 (lon, lat, ellipsoidal height), the tile columns, and the attributes.
- **Node** converts every vertex to the tile's ENU frame in float64, triangulates, and computes flat normals.

The mesh builder supports two kinds of input, so both data sources go through the same worker:

| Source              | Geometry in the table                                          | What Node does                                                                          |
| ------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| **3DBAG** (first)   | `MultiPolygonZ` of planar 3D faces (walls, roof parts, ground) | Triangulate each face: Newell normal, project onto the face plane, `earcut` with holes. |
| **OSM** (osm2pgsql) | 2D footprint `MultiPolygon` + `height`, `min_height`, `base_h` | Extrude: walls as quads, roof and floor with `earcut`, then the same path as above.     |

This is a few hundred lines of pure, unit-testable code. Workers scale horizontally and the database does index lookups only.

**Feature flag.** `app.tiling.geometryBuilder` (`TILING_GEOMETRY_BUILDER`) is `node` (the default) or `postgis`. In `postgis` mode SFCGAL tesselates every face and `ST_TransformPipeline` converts it to the tile frame, so the worker only collects triangles. An integration test checks that both builders produce the same mesh within 1 mm. Two things came up against the `postgis/postgis:16-3.4` image:

- It ships **PROJ 7.2**, which has no `+proj=topocentric` (that arrived in PROJ 8). The ENU step is therefore written as `+proj=cart` followed by an `+proj=affine` with the tile rotation and offset, which works with PROJ 6 and later.
- SFCGAL 1.3 **throws on invalid faces**, and 3DBAG has faces with a repeated vertex. That failed the whole tile. Each face is now tesselated through a session-temporary PL/pgSQL function that returns NULL for a face SFCGAL rejects, and the face is skipped, as the node builder does. This needs only the default `TEMP` privilege.

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

### 1.4 First data source: 3DBAG

The first dataset is a [3DBAG](https://3dbag.nl) tile GeoPackage (tile `8-688-40`). This changes the data phase: 3DBAG already contains full 3D buildings with absolute heights, so there is no extrusion and no DEM for it.

What we expect in the GeoPackage (to verify on the file, the session could not download it):

- Layers `pand` (attributes and 2D footprint) and `lod12_3d`, `lod13_3d`, `lod22_3d` (3D geometry, one `MultiPolygonZ` of faces per building part). We start with **LoD 2.2**.
- CRS **EPSG:7415**: RD New (EPSG:28992) horizontally and NAP heights (EPSG:5709) vertically.
- Building id `identificatie` (a string such as `NL.IMBAG.Pand.0503100000012345`), plus attributes such as `b3_h_maaiveld` (ground height), `b3_dak_type` and `oorspronkelijkbouwjaar`.

Converting to EPSG:4979 needs **two PROJ grids**, or heights and positions come out wrong without any error:

- `nl_nsgi_rdtrans2018.tif` (RDNAPTRANS) for RD → ETRS89 horizontally, which is accurate to about 1 cm instead of about 1 m.
- `nl_nsgi_nlgeo2018.tif` (the NLGEO2018 geoid) for NAP → ellipsoidal height. It adds about **+43 m**. Without it PROJ falls back to a ballpark transform that keeps the NAP height, and buildings end up about 43 m too low.

The import (track D) converts once, at load time, with `ogr2ogr -t_srs EPSG:4979` and `PROJ_NETWORK=ON` (or the grids installed locally). It then fills the tile columns in SQL, so the worker only ever reads EPSG:4979.

**Terrain:** 3DBAG heights are absolute, so buildings land at the right ellipsoidal height whatever the client shows. With Cesium's default ellipsoid (no terrain) they look about 43 m above the globe surface in the Netherlands. With a terrain in ellipsoidal heights (Cesium World Terrain or an equivalent) they sit on the ground. For OSM later, `base_h` must come from the same DEM as the client terrain.

### 1.5 GLB node transform (confirming the design)

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

- [x] Resolve the open questions in §4 (grid, geometry in Node, local config schema, metatile-queue-populator).
- [ ] Freeze the `buildings` table contract: columns, types, SRID, indexes (§D).
- [x] Config schema: a local schema (`src/common/configSchema.ts`) loaded in offline mode. It reuses the shared db and telemetry schemas from `@map-colonies/schemas` by `$ref`.

### M1: Worker skeleton ✅

- [x] Remove the boilerplate REST resources, OpenAPI router and `serverBuilder`. Keep vitest, eslint, prettier, husky, Dockerfile and helm.
- [x] Port from retiler: `index.ts` (terminus liveness, `/metrics`), `CleanupRegistry`, `ON_SIGNAL`, and `postInjectionHook` / `afterAllInjectionHook` in `dependencyRegistration.ts`.
- [x] Port `PgBossJobQueueProvider` and `pgbossFactory` (pg-boss 12) with their unit tests, converted from jest to vitest.
- [x] Config: `app.queueName`, `app.parallelism`, `app.jobQueue.pgBoss.*`. `db.*`, `app.tiling.*` and `app.tilesStorage.*` are added by the milestones that use them.
- **Done when:** the worker starts, consumes a dummy queue, and shuts down gracefully. _Verified against a local Postgres 16: a job was fetched, failed with the "not implemented" stub, and SIGTERM drained the queue and ran the cleanup registry._

### M2: DB layer ✅

- [x] `common/db/index.ts` in the osm-sync-tracker style: SSL from files, cached `DataSource`, health check (included in liveness together with pg-boss).
- [x] `building` entity and `BuildingRepository.findByTileRanges` (one range per content level, from `getMetatileContentRanges`). `findContentTilesInSubtree` comes with M7.
- [x] Integration tests against PostGIS (a `postgis/postgis` service in CI), using the same DDL as the import.
- **Done when:** the repository returns the expected rows for a metatile, and `EXPLAIN` shows an index scan. _Verified on the imported 3DBAG tile: a bitmap OR of index scans on `buildings_tile_idx`, 570 rows for the densest z13 area._

### M3: Tiling math ✅

- [x] `grid.ts`: hemisphere mapping, y flip, tile bounds, `getMetatileContentTiles`, `getSubtreeRoot`, `lonLatToGridTile`.
- [x] `enu.ts`: WGS84 geodetic→ECEF, ENU basis, column-major node matrix including Z_UP_TO_Y_UP.
- [x] `tileset.ts`: the static root `tileset.json` with the two hemisphere children.
- [x] Tests: compared against `@cesium/engine` (devDependency) `Cartesian3.fromDegrees`, `Transforms.eastNorthUpToFixedFrame` and `Axis.Z_UP_TO_Y_UP` to within 1e-6 m, and the grid against `@map-colonies/tile-calc` `WorldCRS84Quad`.

### M4: Mesh builder ✅

- [x] WKB parsing (`src/mesh/wkb.ts`: Polygon, MultiPolygon, TIN and Triangle, ISO and EWKB, with or without Z).
- [x] **3D faces first (3DBAG):** per face, a Newell normal, projection onto the face plane, `earcut` with holes, and every triangle wound like its face.
- [x] The `postgis` builder behind the feature flag (§1.2).
- [ ] Extrusion for 2D footprints (OSM, later): from `base_h + min_height` to `base_h + height`, walls as quads with flat normals, and roof and floor with `earcut`.
- [x] A per-vertex `_FEATURE_ID_0`.
- [x] Tests: areas, normals pointing outward, a polygon with a hole, a sloped roof face, degenerate faces, and node against PostGIS.

### M5: GLB encoder ✅ (except compression)

- [x] A small GLB writer of our own (`src/glb/glbWriter.ts`) instead of gltf-transform, which drops extensions it does not know: one primitive per tile, float32 ENU positions, normals, `COLOR_0` by face label, feature ids, and a property table (id, building_id, height, ground_height, construction_year, roof_type).
- [ ] `EXT_meshopt_compression` with `KHR_mesh_quantization`. This needs `EXT_mesh_features` / `EXT_structural_metadata` gltf-transform extension classes first.
- [x] Tests: the Khronos `gltf-validator` reports no errors and no warnings, and buffer views are 8-byte aligned.

### M6: End-to-end tile job (the design's **Phase 2 gate**)

> **Job size.** metatile-queue-populator sends jobs with `metatile = 8`, which is an 8×8 block of tiles at the job zoom `z`, or one tile at `z − 3`. With content at z14/z15, a job at `z = 16` covers one z13 tile: 4 + 16 = 20 GLBs. A job at `z = 14` covers a z11 tile: 64 + 256 = 320 GLBs, and one query could return tens of thousands of buildings in a city. The processor therefore queries and encodes **one content tile range at a time**, never the whole job in memory. The populator zoom is a tuning setting.

- [x] FS storage (atomic writes) with content types. S3 storage is not done yet.
- [x] `TileProcessor.processMetatile`: one content tile at a time, tracing spans, metrics (`tiler3d_content_tiles_count`, `tiler3d_action_duration_seconds` by `build|encode|store`), and empty-tile deletion.
- [x] The subtree worker writes the static `tileset.json` at startup (§1.1).
- [x] `cli/seed.ts` queues one job per metatile area that has buildings, as metatile-queue-populator would.
- **Gate (on the 3DBAG tile):** _passed._ `3d-tiles-validator` 0.6.1 reports 0 errors and 0 warnings. Cesium renders the buildings, which line up with the OpenStreetMap footprints. Picking returns the database values. The largest z15 tile is 0.93 MB uncompressed with the node builder, under the 1–2 MB target before any compression. The design's Tel Aviv gate still needs Israeli data.

### M7: Subtrees and availability ✅

- [x] `subtree.ts` binary writer: header, JSON, 8-byte aligned bitstreams, with `constant` used when a bitstream is all 0 or all 1.
- [x] Tile availability is the content tiles plus all of their ancestors, and child subtree availability marks the subtrees below with content. Hemisphere roots are always written.
- [x] `SubtreeProcessor` (`app.mode = 'subtrees'`) on a pg-boss `stately` queue keyed by subtree, enqueued by tile jobs.
- [x] Tests: bit positions and the header, and the validator passes on a generated tileset. Subtrees are rebuilt from the buildings table, which is a full index scan for a hemisphere root. A `content_tiles` table can replace it when the data grows.

### M8: Ops (partly)

- [ ] Helm: two deployments (tiles and subtrees) from one chart, with values for both queues, the DB, S3 and SSL secrets.
- [ ] S3 bucket CORS and MIME types documented.
- [ ] Grafana dashboard based on `retiler/dashboards/instance.json`.
- [x] README: `docker compose` (PostGIS, 3DBAG import, seed, both workers, a Cesium viewer), and a config reference. MinIO comes with S3 storage.

### Parallel track D: Data

**D1: 3DBAG import (first)** ✅

- [x] `scripts/3dbag/import.sh`: `ogr2ogr` loads `pand` and `lod22_3d` into a staging schema in their native EPSG:7415. `upsert_3dbag.sql` then upserts them into `buildings` in **EPSG:4979** with PostGIS `ST_Transform`.
- [x] Geoid guard: without `nl_nsgi_nlgeo2018.tif`, PostGIS returns NAP 0 m at the RD origin as 0 m instead of 43.28 m, with no error. The upsert checks that point and aborts.
- [x] Tile columns `tile_z`, `tile_x`, `tile_y` (WorldCRS84Quad, y from the north, the same as `grid.ts`) come from the `pand` footprint centroid, with an index on `(tile_z, tile_x, tile_y)`. **Change from the design:** there are no `meta_x`/`meta_y` columns. The worker turns a job into one tile range per content level, so the metatile size can change without re-importing.
- [x] Table contract (`scripts/3dbag/buildings.sql`): one row per building part, with `id`, `building_id`, `source`, `geom geometry(MultiPolygonZ, 4979)`, `face_labels smallint[]` (0 ground, 1 roof, 2 wall), `ground_height`, `height`, `footprint_area`, `construction_year`, `roof_type` and the tile columns.
- Tile `8-688-40` (Valkenburg, Limburg): 1,003 parts from 1,002 buildings. 23 are at z14 and 980 at z15, spread over 24 content tiles in 5 z13 areas. Ellipsoidal ground heights are 115–176 m.

**D2: OSM (osm2pgsql flex, later)**

- [ ] Flex Lua style for `buildings`: `height` from the `height` tag, else `building:levels × 3 m`, else a default; `min_height`; tile and metatile columns computed in Lua from the centroid using the same grid as `grid.ts` (shared test vectors); index `(meta_x, meta_y)`.
- [ ] Base elevation: a DEM raster table (`postgis_raster`) plus geoid, filled by an insert/update trigger, or sampled at render time. **Decision needed (§4).**
- [x] Expiry: the osm2pgsql fork outputs expired tiles in EPSG:4326, which metatile-queue-populator turns into WorldCRS84Quad jobs. That grid is the one `grid.ts` uses. A building that moves expires both its old and new metatiles.

### Later

- Detiler integration (skip tiles that are already up to date, cooldowns), in the same pattern as retiler.
- A z16 content level for dense areas, and `TILE_BOUNDING_REGION` subtree metadata.
- An OGC API – Features service for picking and identifying features.

---

## 4. Decisions

Resolved:

1. **Grid:** two hemisphere roots aligned with WorldCRS84Quad (§1.1), because the jobs come from metatile-queue-populator.
2. **Geometry:** built in Node (§1.2). SFCGAL is not required.
3. **Config schema:** a local schema in offline mode.
4. **Source data:** 3DBAG first (§1.4), OSM later.
5. **Queue producer:** metatile-queue-populator, with the osm2pgsql fork that outputs expired tiles in EPSG:4326.

Still open:

1. **SFCGAL:** not needed, because geometry is built in Node. It was only needed for the design's SQL extrusion (`CG_Extrude`, `CG_Tesselate`).
2. **Client terrain:** postponed. It does not block 3DBAG (§1.4), but it does block `base_h` for OSM.
3. **Content levels:** z14/z15 with the halved WorldCRS84Quad tiles, or z13/z14. This will be decided from the tile sizes measured at the M6 gate.

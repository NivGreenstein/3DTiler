-- Extrudes the 2D building footprints of the staging table into 3D faces, and upserts them into the buildings table.
-- Every footprint polygon becomes a ground face (facing down), a roof face (facing up) and one wall per edge (facing out),
-- holes included, so footprints go through the same worker path as full 3D sources such as 3DBAG.
-- psql variables: schema, staging_table, source, id_expr, height_expr, min_height_expr, roof_type_expr, ground_height,
-- large_height (m), large_area (m2), large_level, small_level. The *_expr variables are SQL expressions over the staging row f.
BEGIN;

CREATE TEMPORARY TABLE footprints ON COMMIT DROP AS
SELECT
  (:id_expr)::text AS id,
  ST_CollectionExtract(ST_MakeValid(ST_RemoveRepeatedPoints(ST_Force2D(f.geom))), 3) AS footprint,
  greatest((:height_expr)::double precision, 0.1) AS height,
  coalesce((:min_height_expr)::double precision, 0) AS min_height,
  (:roof_type_expr)::text AS roof_type
FROM :staging_table AS f
WHERE f.geom IS NOT NULL;

DELETE FROM footprints WHERE ST_IsEmpty(footprint) OR height <= min_height;

CREATE TEMPORARY TABLE faces ON COMMIT DROP AS
WITH polygons AS (
  SELECT
    fp.id,
    part.path[1] AS polygon_index,
    ST_ForcePolygonCCW(part.geom) AS polygon,
    :ground_height + fp.min_height AS base,
    :ground_height + fp.height AS top
  FROM footprints fp, LATERAL ST_Dump(fp.footprint) AS part
),
walls AS (
  SELECT
    p.id,
    p.polygon_index,
    segment.path AS segment_path,
    ST_SetSRID(ST_MakePolygon(ST_MakeLine(ARRAY[
      ST_MakePoint(ST_X(ST_StartPoint(segment.geom)), ST_Y(ST_StartPoint(segment.geom)), p.base),
      ST_MakePoint(ST_X(ST_EndPoint(segment.geom)), ST_Y(ST_EndPoint(segment.geom)), p.base),
      ST_MakePoint(ST_X(ST_EndPoint(segment.geom)), ST_Y(ST_EndPoint(segment.geom)), p.top),
      ST_MakePoint(ST_X(ST_StartPoint(segment.geom)), ST_Y(ST_StartPoint(segment.geom)), p.top),
      ST_MakePoint(ST_X(ST_StartPoint(segment.geom)), ST_Y(ST_StartPoint(segment.geom)), p.base)
    ])), ST_SRID(p.polygon)) AS face
  FROM polygons p, LATERAL ST_DumpSegments(p.polygon) AS segment
  WHERE ST_Length(segment.geom) > 0
)
-- face order inside a building: per polygon the ground (0), the roof (1), then its walls (2)
SELECT id, polygon_index, 0 AS face_order, ARRAY[]::int[] AS segment_path, 0::smallint AS label, ST_Force3DZ(ST_Reverse(polygon), base) AS face
FROM polygons
UNION ALL
SELECT id, polygon_index, 1, ARRAY[]::int[], 1::smallint, ST_Force3DZ(polygon, top)
FROM polygons
UNION ALL
SELECT id, polygon_index, 2, segment_path, 2::smallint, face
FROM walls;

WITH buildings AS (
  SELECT
    id,
    ST_Collect(face ORDER BY polygon_index, face_order, segment_path) AS geom,
    array_agg(label ORDER BY polygon_index, face_order, segment_path) AS face_labels
  FROM faces
  GROUP BY id
),
tiled AS (
  SELECT
    b.id,
    b.geom,
    b.face_labels,
    fp.height - fp.min_height AS height,
    :ground_height + fp.min_height AS ground_height,
    ST_Area(fp.footprint::geography) AS footprint_area,
    fp.roof_type,
    ST_Centroid(fp.footprint) AS centroid,
    CASE WHEN fp.height >= :large_height OR ST_Area(fp.footprint::geography) >= :large_area THEN :large_level ELSE :small_level END AS tile_z
  FROM buildings b
  JOIN footprints fp USING (id)
)
INSERT INTO :"schema".buildings (
  id, building_id, source, geom, face_labels, ground_height, height, footprint_area, construction_year, roof_type, tile_z, tile_x, tile_y
)
SELECT
  id, id, :'source', ST_SetSRID(ST_Multi(geom), 4326), face_labels, ground_height, height, footprint_area, NULL, roof_type, tile_z,
  floor((ST_X(centroid) + 180) / (180 / 2 ^ tile_z))::integer,
  floor((90 - ST_Y(centroid)) / (180 / 2 ^ tile_z))::integer
FROM tiled
ON CONFLICT (id) DO UPDATE SET
  building_id = EXCLUDED.building_id,
  source = EXCLUDED.source,
  geom = EXCLUDED.geom,
  face_labels = EXCLUDED.face_labels,
  ground_height = EXCLUDED.ground_height,
  height = EXCLUDED.height,
  footprint_area = EXCLUDED.footprint_area,
  construction_year = EXCLUDED.construction_year,
  roof_type = EXCLUDED.roof_type,
  tile_z = EXCLUDED.tile_z,
  tile_x = EXCLUDED.tile_x,
  tile_y = EXCLUDED.tile_y,
  updated_at = now();

COMMIT;

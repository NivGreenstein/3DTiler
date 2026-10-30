-- Moves one loaded 3DBAG tile from the staging schema (already converted to EPSG:4979 by ogr2ogr) into the buildings table.
-- psql variables: schema, staging_schema, large_height (m), large_area (m2), large_level, small_level
BEGIN;

WITH parts AS (
  SELECT
    l.identificatie || '-' || l.b3_pand_deel_id AS id,
    l.identificatie AS building_id,
    ST_SetSRID(l.geom, 4326) AS geom,
    string_to_array(split_part(btrim(l.labels, '()'), ':', 2), ',')::smallint[] AS face_labels,
    p.b3_opp_grond AS footprint_area,
    p.oorspronkelijkbouwjaar::smallint AS construction_year,
    p.b3_dak_type AS roof_type,
    ST_Centroid(ST_Force2D(p.geom)) AS centroid
  FROM :"staging_schema".lod22_3d l
  JOIN :"staging_schema".pand p USING (identificatie)
),
sized AS (
  SELECT *,
    ST_ZMin(geom) AS ground_height,
    ST_ZMax(geom) - ST_ZMin(geom) AS height
  FROM parts
),
tiled AS (
  SELECT *,
    CASE WHEN height >= :large_height OR footprint_area >= :large_area THEN :large_level ELSE :small_level END AS tile_z
  FROM sized
)
INSERT INTO :"schema".buildings (
  id, building_id, source, geom, face_labels, ground_height, height, footprint_area, construction_year, roof_type, tile_z, tile_x, tile_y
)
SELECT
  id, building_id, '3dbag', geom, face_labels, ground_height, height, footprint_area, construction_year, roof_type, tile_z,
  floor((ST_X(centroid) + 180) / (180 / 2 ^ tile_z))::integer,
  floor((90 - ST_Y(centroid)) / (180 / 2 ^ tile_z))::integer
FROM tiled
ON CONFLICT (id) DO UPDATE SET
  building_id = EXCLUDED.building_id,
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

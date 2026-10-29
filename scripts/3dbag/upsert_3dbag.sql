-- Moves one loaded 3DBAG tile from the staging schema into the buildings table.
-- psql variables: schema, staging_schema, large_height (m), large_area (m2), large_level, small_level
BEGIN;

-- PROJ silently keeps NAP heights when the NLGEO2018 geoid grid is missing, so check a known point first:
-- NAP 0 m at the RD origin is about 43.28 m above the WGS84 ellipsoid.
DO $$
DECLARE
  h double precision := ST_Z(ST_Transform(ST_SetSRID(ST_MakePoint(155000, 463000, 0), 7415), 4979));
BEGIN
  IF abs(h - 43.277) > 0.01 THEN
    RAISE EXCEPTION 'EPSG:7415 to EPSG:4979 gave a height of % m at the RD origin instead of 43.277 m, install the PROJ grids nl_nsgi_nlgeo2018.tif and nl_nsgi_rdtrans2018.tif', h;
  END IF;
END
$$;

WITH parts AS (
  SELECT
    l.identificatie || '-' || l.b3_pand_deel_id AS id,
    l.identificatie AS building_id,
    ST_Transform(l.geom, 4979) AS geom,
    string_to_array(split_part(btrim(l.labels, '()'), ':', 2), ',')::smallint[] AS face_labels,
    p.b3_opp_grond AS footprint_area,
    p.oorspronkelijkbouwjaar::smallint AS construction_year,
    p.b3_dak_type AS roof_type,
    ST_Transform(ST_Centroid(p.geom), 4326) AS centroid
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

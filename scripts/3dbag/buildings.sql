-- The table the 3DTiler worker reads. Every source (3DBAG now, OSM later) is loaded into it in EPSG:4979
-- (longitude, latitude, ellipsoidal height), with the content tile of every building already assigned.
-- psql variables: schema
CREATE SCHEMA IF NOT EXISTS :"schema";

CREATE TABLE IF NOT EXISTS :"schema".buildings (
  id text PRIMARY KEY,
  building_id text NOT NULL,
  source text NOT NULL,
  geom geometry(MultiPolygonZ, 4979) NOT NULL,
  -- the semantic label of every face of geom, in order: 0 ground, 1 roof, 2 outer wall (3DBAG / CityJSON semantics)
  face_labels smallint[],
  ground_height real NOT NULL,
  height real NOT NULL,
  footprint_area real,
  construction_year smallint,
  roof_type text,
  -- the content tile in the WorldCRS84Quad grid, y counted from the north edge
  tile_z smallint NOT NULL,
  tile_x integer NOT NULL,
  tile_y integer NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS buildings_tile_idx ON :"schema".buildings (tile_z, tile_x, tile_y);

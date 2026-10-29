#!/usr/bin/env bash
# Imports 3DBAG tile GeoPackages (https://3dbag.nl/en/download) into the buildings table read by 3DTiler.
# Usage: PGHOST=... PGUSER=... PGDATABASE=... ./import.sh <tile.gpkg>...
# Requires ogr2ogr, cs2cs, psql, and the PROJ grids nl_nsgi_rdtrans2018.tif and nl_nsgi_nlgeo2018.tif (https://cdn.proj.org)
# in the PROJ data directory, or PROJ_NETWORK=ON. The data is converted from EPSG:7415 (RD New + NAP) to EPSG:4979 by ogr2ogr.
set -euo pipefail

SCHEMA="${SCHEMA:-public}"
STAGING_SCHEMA="${STAGING_SCHEMA:-bag3d_staging}"
LARGE_HEIGHT="${LARGE_HEIGHT:-15}"
LARGE_AREA="${LARGE_AREA:-500}"
LARGE_LEVEL="${LARGE_LEVEL:-14}"
SMALL_LEVEL="${SMALL_LEVEL:-15}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ $# -eq 0 ]]; then
  echo "usage: $0 <tile.gpkg>..." >&2
  exit 1
fi

# PROJ silently keeps NAP heights when the NLGEO2018 geoid grid is missing, so check a known point first:
# NAP 0 m at the RD origin is about 43.277 m above the WGS84 ellipsoid.
height="$(echo "155000 463000 0" | cs2cs -d 3 --only-best EPSG:7415 EPSG:4979 | awk '{print $3}')"
if [[ "$height" != "43.277" ]]; then
  echo "EPSG:7415 to EPSG:4979 gave a height of '$height' m at the RD origin instead of 43.277 m," >&2
  echo "install the PROJ grids nl_nsgi_nlgeo2018.tif and nl_nsgi_rdtrans2018.tif or set PROJ_NETWORK=ON" >&2
  exit 1
fi

PSQL=(psql -v ON_ERROR_STOP=1 -q -v schema="$SCHEMA" -v staging_schema="$STAGING_SCHEMA")

"${PSQL[@]}" -f "$SCRIPT_DIR/buildings.sql"
"${PSQL[@]}" -c "CREATE SCHEMA IF NOT EXISTS \"$STAGING_SCHEMA\""

for gpkg in "$@"; do
  echo "importing $gpkg"
  for layer in pand lod22_3d; do
    ogr2ogr -f PostgreSQL "PG:" "$gpkg" "$layer" -nln "$STAGING_SCHEMA.$layer" -lco GEOMETRY_NAME=geom -lco FID=fid -overwrite \
      -s_srs EPSG:7415 -t_srs EPSG:4979
  done
  "${PSQL[@]}" -v large_height="$LARGE_HEIGHT" -v large_area="$LARGE_AREA" -v large_level="$LARGE_LEVEL" -v small_level="$SMALL_LEVEL" \
    -f "$SCRIPT_DIR/upsert_3dbag.sql"
done

"${PSQL[@]}" -c "ANALYZE \"$SCHEMA\".buildings"

#!/usr/bin/env bash
# Imports 2D building footprints (any OGR format and CRS, e.g. a GeoPackage in EPSG:4326) into the buildings table read by 3DTiler,
# extruding every footprint from the ground to its height.
# Usage: PGHOST=... PGUSER=... PGDATABASE=... ./import.sh <file> [layer]
#
# The attribute mapping is given as SQL expressions over the source row f. The defaults fit Overture Maps buildings
# (scripts/overture/extract_buildings.py): height, then num_floors x FLOOR_HEIGHT, then DEFAULT_HEIGHT.
#   ID_EXPR, HEIGHT_EXPR, MIN_HEIGHT_EXPR, ROOF_TYPE_EXPR
# GROUND_HEIGHT is the ellipsoidal height of the ground for every building (meters, default 0). Until a DEM is sampled, 0 puts the
# buildings on the WGS84 ellipsoid, which is the globe surface of a viewer without terrain.
set -euo pipefail

SCHEMA="${SCHEMA:-public}"
STAGING_SCHEMA="${STAGING_SCHEMA:-footprints_staging}"
SOURCE="${SOURCE:-footprints}"
FLOOR_HEIGHT="${FLOOR_HEIGHT:-3}"
DEFAULT_HEIGHT="${DEFAULT_HEIGHT:-9}"
ID_EXPR="${ID_EXPR:-f.id}"
HEIGHT_EXPR="${HEIGHT_EXPR:-coalesce(f.height, f.num_floors * $FLOOR_HEIGHT, $DEFAULT_HEIGHT)}"
MIN_HEIGHT_EXPR="${MIN_HEIGHT_EXPR:-f.min_height}"
ROOF_TYPE_EXPR="${ROOF_TYPE_EXPR:-f.roof_shape}"
GROUND_HEIGHT="${GROUND_HEIGHT:-0}"
LARGE_HEIGHT="${LARGE_HEIGHT:-15}"
LARGE_AREA="${LARGE_AREA:-500}"
LARGE_LEVEL="${LARGE_LEVEL:-14}"
SMALL_LEVEL="${SMALL_LEVEL:-15}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <file> [layer]" >&2
  exit 1
fi
file="$1"
layer="${2:-}"
staging_table="$STAGING_SCHEMA.footprints"

PSQL=(psql -v ON_ERROR_STOP=1 -q -v schema="$SCHEMA")

"${PSQL[@]}" -f "$SCRIPT_DIR/../buildings.sql"
"${PSQL[@]}" -c "CREATE SCHEMA IF NOT EXISTS \"$STAGING_SCHEMA\""

echo "loading $file ${layer:+(layer $layer)}"
ogr2ogr -f PostgreSQL "PG:" "$file" ${layer:+"$layer"} -nln "$staging_table" -lco GEOMETRY_NAME=geom -lco FID=fid -overwrite \
  -t_srs EPSG:4326 -nlt MULTIPOLYGON -dim XY

echo "extruding footprints"
"${PSQL[@]}" -v staging_table="$staging_table" -v source="$SOURCE" -v id_expr="$ID_EXPR" -v height_expr="$HEIGHT_EXPR" \
  -v min_height_expr="$MIN_HEIGHT_EXPR" -v roof_type_expr="$ROOF_TYPE_EXPR" -v ground_height="$GROUND_HEIGHT" \
  -v large_height="$LARGE_HEIGHT" -v large_area="$LARGE_AREA" -v large_level="$LARGE_LEVEL" -v small_level="$SMALL_LEVEL" \
  -f "$SCRIPT_DIR/upsert_footprints.sql"

"${PSQL[@]}" -c "ANALYZE \"$SCHEMA\".buildings"

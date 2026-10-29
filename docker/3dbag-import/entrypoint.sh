#!/usr/bin/env bash
# Downloads the 3DBAG tiles in TILE_IDS (space separated, e.g. "8-688-40 8-688-48") of BAG3D_VERSION, and the PROJ grids that
# the EPSG:7415 to EPSG:4979 transformation needs, into DATA_DIR (kept between runs), then imports the tiles.
set -euo pipefail

DATA_DIR="${DATA_DIR:-/data}"
BAG3D_VERSION="${BAG3D_VERSION:-v20250903}"
TILE_IDS="${TILE_IDS:-8-688-40}"
GRIDS=(nl_nsgi_rdtrans2018.tif nl_nsgi_nlgeo2018.tif)

mkdir -p "$DATA_DIR/proj" "$DATA_DIR/3dbag"

# PROJ searches its user writable directory for grids
export PROJ_USER_WRITABLE_DIRECTORY="$DATA_DIR/proj"
for grid in "${GRIDS[@]}"; do
  if [[ ! -f "$DATA_DIR/proj/$grid" ]]; then
    echo "downloading PROJ grid $grid"
    curl -fsSL -o "$DATA_DIR/proj/$grid.part" "https://cdn.proj.org/$grid"
    mv "$DATA_DIR/proj/$grid.part" "$DATA_DIR/proj/$grid"
  fi
done

gpkgs=()
for tile_id in $TILE_IDS; do
  gpkg="$DATA_DIR/3dbag/$tile_id.gpkg"
  if [[ ! -f "$gpkg" ]]; then
    url="https://data.3dbag.nl/$BAG3D_VERSION/tiles/${tile_id//-//}/$tile_id.gpkg.gz"
    echo "downloading $url"
    curl -fsSL "$url" | gunzip > "$gpkg.part"
    mv "$gpkg.part" "$gpkg"
  fi
  gpkgs+=("$gpkg")
done

exec /opt/3dbag/import.sh "${gpkgs[@]}"

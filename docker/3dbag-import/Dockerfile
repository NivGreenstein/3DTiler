# The import scripts: 3DBAG tiles (the default entrypoint) and 2D footprint files (/opt/footprints/import.sh).
FROM ghcr.io/osgeo/gdal:ubuntu-small-3.9.3

RUN apt-get update \
  && apt-get install -y --no-install-recommends postgresql-client \
  && rm -rf /var/lib/apt/lists/*

COPY scripts/buildings.sql /opt/buildings.sql
COPY scripts/3dbag /opt/3dbag
COPY scripts/footprints /opt/footprints
COPY docker/3dbag-import/entrypoint.sh /opt/3dbag/entrypoint.sh

ENTRYPOINT ["/opt/3dbag/entrypoint.sh"]

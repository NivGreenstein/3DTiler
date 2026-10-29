# Downloads 3DBAG tiles and the Dutch PROJ grids, and imports the tiles into the buildings table.
FROM ghcr.io/osgeo/gdal:ubuntu-small-3.9.3

RUN apt-get update \
  && apt-get install -y --no-install-recommends postgresql-client \
  && rm -rf /var/lib/apt/lists/*

COPY scripts/3dbag /opt/3dbag
COPY docker/3dbag-import/entrypoint.sh /opt/3dbag/entrypoint.sh

ENTRYPOINT ["/opt/3dbag/entrypoint.sh"]

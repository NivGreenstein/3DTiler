"""Extracts Overture Maps buildings inside a bounding box into a GeoPackage in EPSG:4326.

The result is a footprint file for scripts/footprints/import.sh, whose default attribute mapping fits it.

    pip install duckdb
    python scripts/overture/extract_buildings.py --bbox 34.74,32.04,34.82,32.12 tel-aviv-buildings.gpkg

Releases are listed at https://docs.overturemaps.org/release-calendar/, older ones are removed from the bucket after a while.
"""

import argparse

import duckdb

DEFAULT_RELEASE = '2026-10-21.0'
BUILDINGS_PATH = 's3://overturemaps-us-west-2/release/{release}/theme=buildings/type=building/*'


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('output', help='the GeoPackage to write')
    parser.add_argument('--bbox', required=True, help='west,south,east,north in degrees')
    parser.add_argument('--release', default=DEFAULT_RELEASE, help=f'the Overture release (default {DEFAULT_RELEASE})')
    parser.add_argument('--http-proxy', help='host:port of an HTTP proxy, DuckDB does not read the proxy environment variables')
    parser.add_argument('--ca-cert-file', help='a CA bundle for the proxy')
    args = parser.parse_args()

    west, south, east, north = (float(value) for value in args.bbox.split(','))

    con = duckdb.connect()
    for extension in ('httpfs', 'spatial'):
        con.install_extension(extension)
        con.load_extension(extension)
    con.execute('SET geometry_always_xy = true')
    if args.http_proxy:
        con.execute('SET http_proxy = ?', [args.http_proxy])
    if args.ca_cert_file:
        con.execute('SET ca_cert_file = ?', [args.ca_cert_file])
    # the bucket is public, ignore any AWS credentials of the environment
    con.execute("CREATE OR REPLACE SECRET overture (TYPE s3, PROVIDER config, KEY_ID '', SECRET '', REGION 'us-west-2')")

    con.execute(
        f"""
        CREATE TABLE buildings AS
        SELECT id, names.primary AS name, subtype, class, height, min_height, num_floors, min_floor, roof_shape, roof_height,
               sources[1].dataset AS source_dataset, geometry
        FROM read_parquet('{BUILDINGS_PATH.format(release=args.release)}', hive_partitioning = 1)
        WHERE bbox.xmin < ? AND bbox.xmax > ? AND bbox.ymin < ? AND bbox.ymax > ?
          AND NOT coalesce(is_underground, false)
        """,
        [east, west, north, south],
    )

    count, with_height, with_floors = con.execute('SELECT count(*), count(height), count(num_floors) FROM buildings').fetchone()
    print(f'{count} buildings, {with_height} with a height, {with_floors} with a number of floors')

    con.execute(f"COPY buildings TO '{args.output}' WITH (FORMAT GDAL, DRIVER 'GPKG', SRS 'EPSG:4326', LAYER_NAME 'buildings')")


if __name__ == '__main__':
    main()

import { createEnuFrame, type EnuFrame } from '@src/tiling/enu';
import { getTileCenter, type GridTile } from '@src/tiling/grid';
import type { TileFrame } from './interfaces';

/**
 * Returns the frame of a content tile. The SQL path and the node path, and the GLB node matrix, must all use this frame.
 */
const getTileFrame = (tile: GridTile): TileFrame => {
  const center = getTileCenter(tile);
  return { center, enu: createEnuFrame(center.lon, center.lat, 0) };
};

const dot = (a: readonly number[], b: readonly number[]): number =>
  (a[0] as number) * (b[0] as number) + (a[1] as number) * (b[1] as number) + (a[2] as number) * (b[2] as number);

/**
 * A PROJ pipeline from EPSG:4326 (longitude, latitude, ellipsoidal height) to the ENU frame, for ST_TransformPipeline.
 * The ENU step is an affine of the geocentric coordinates (enu = R * (ecef - origin)) instead of +proj=topocentric, which only
 * exists from PROJ 8 while the affine works with PROJ 6 and later.
 */
const getEnuPipeline = (frame: EnuFrame): string => {
  const { east, north, up, origin } = frame;
  const affine = [
    `+xoff=${-dot(east, origin)} +s11=${east[0]} +s12=${east[1]} +s13=${east[2]}`,
    `+yoff=${-dot(north, origin)} +s21=${north[0]} +s22=${north[1]} +s23=${north[2]}`,
    `+zoff=${-dot(up, origin)} +s31=${up[0]} +s32=${up[1]} +s33=${up[2]}`,
  ].join(' ');

  return ['+proj=pipeline', '+step +proj=unitconvert +xy_in=deg +xy_out=rad', '+step +proj=cart +ellps=WGS84', `+step +proj=affine ${affine}`].join(
    ' '
  );
};

export { getTileFrame, getEnuPipeline };

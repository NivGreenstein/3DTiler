// WGS84 geodetic, ECEF and local east-north-up (ENU) frame math, all in float64.
// Each content tile gets an ENU frame at its center so vertex positions stay small and keep their precision as float32.

type Vec3 = [number, number, number];

/**
 * A 4x4 matrix in column-major order, as glTF and Cesium expect it.
 */
type Mat4 = [number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number];

const WGS84_SEMI_MAJOR_AXIS = 6378137;
const WGS84_INVERSE_FLATTENING = 298.257223563;
const WGS84_FLATTENING = 1 / WGS84_INVERSE_FLATTENING;
const WGS84_FIRST_ECCENTRICITY_SQUARED = WGS84_FLATTENING * (2 - WGS84_FLATTENING); // eslint-disable-line @typescript-eslint/no-magic-numbers
const DEGREES_IN_HALF_CIRCLE = 180;

const toRadians = (degrees: number): number => (degrees * Math.PI) / DEGREES_IN_HALF_CIRCLE;

/**
 * Converts geodetic coordinates (degrees, ellipsoidal height in meters) into ECEF (EPSG:4978) meters.
 */
const geodeticToEcef = (lon: number, lat: number, height: number): Vec3 => {
  const lonRad = toRadians(lon);
  const latRad = toRadians(lat);
  const sinLat = Math.sin(latRad);
  const cosLat = Math.cos(latRad);
  const primeVerticalRadius = WGS84_SEMI_MAJOR_AXIS / Math.sqrt(1 - WGS84_FIRST_ECCENTRICITY_SQUARED * sinLat * sinLat);

  return [
    (primeVerticalRadius + height) * cosLat * Math.cos(lonRad),
    (primeVerticalRadius + height) * cosLat * Math.sin(lonRad),
    (primeVerticalRadius * (1 - WGS84_FIRST_ECCENTRICITY_SQUARED) + height) * sinLat,
  ];
};

/**
 * A local tangent plane frame. Its origin is on the ellipsoid surface, and its axes are unit vectors in ECEF.
 */
interface EnuFrame {
  origin: Vec3;
  east: Vec3;
  north: Vec3;
  up: Vec3;
}

const createEnuFrame = (lon: number, lat: number, height = 0): EnuFrame => {
  const lonRad = toRadians(lon);
  const latRad = toRadians(lat);
  const sinLon = Math.sin(lonRad);
  const cosLon = Math.cos(lonRad);
  const sinLat = Math.sin(latRad);
  const cosLat = Math.cos(latRad);

  return {
    origin: geodeticToEcef(lon, lat, height),
    east: [-sinLon, cosLon, 0],
    north: [-sinLat * cosLon, -sinLat * sinLon, cosLat],
    up: [cosLat * cosLon, cosLat * sinLon, sinLat],
  };
};

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * Converts an ECEF point into the ENU frame.
 */
const ecefToEnu = (frame: EnuFrame, point: Vec3): Vec3 => {
  const delta: Vec3 = [point[0] - frame.origin[0], point[1] - frame.origin[1], point[2] - frame.origin[2]];
  return [dot(frame.east, delta), dot(frame.north, delta), dot(frame.up, delta)];
};

/**
 * Converts geodetic coordinates (degrees, ellipsoidal height in meters) into the ENU frame.
 */
const geodeticToEnu = (frame: EnuFrame, lon: number, lat: number, height: number): Vec3 => ecefToEnu(frame, geodeticToEcef(lon, lat, height));

/**
 * The column-major matrix that places ENU coordinates in ECEF, the same as Cesium's Transforms.eastNorthUpToFixedFrame.
 */
const enuToEcefMatrix = (frame: EnuFrame): Mat4 => {
  const { east, north, up, origin } = frame;
  return [east[0], east[1], east[2], 0, north[0], north[1], north[2], 0, up[0], up[1], up[2], 0, origin[0], origin[1], origin[2], 1];
};

/**
 * The column-major rotation from Z-up to Y-up, the same as Cesium's Axis.Z_UP_TO_Y_UP.
 */
// eslint-disable-next-line @typescript-eslint/no-magic-numbers -- a rotation of -90 degrees around the x axis
const Z_UP_TO_Y_UP: Mat4 = [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1];

const MATRIX_SIZE = 4;

const multiplyMatrices = (left: Mat4, right: Mat4): Mat4 => {
  const result = new Array<number>(MATRIX_SIZE * MATRIX_SIZE).fill(0);
  for (let column = 0; column < MATRIX_SIZE; column++) {
    for (let row = 0; row < MATRIX_SIZE; row++) {
      let sum = 0;
      for (let k = 0; k < MATRIX_SIZE; k++) {
        sum += (left[k * MATRIX_SIZE + row] as number) * (right[column * MATRIX_SIZE + k] as number);
      }
      result[column * MATRIX_SIZE + row] = sum;
    }
  }
  return result as Mat4;
};

/**
 * The glTF root node matrix for content whose positions are in the ENU frame.
 * Cesium applies a Y-up to Z-up rotation to all glTF content, so the Z-up to Y-up rotation here cancels it, and the final position is
 * enuToEcef * position.
 */
const getContentNodeMatrix = (frame: EnuFrame): Mat4 => multiplyMatrices(Z_UP_TO_Y_UP, enuToEcefMatrix(frame));

export { toRadians, geodeticToEcef, createEnuFrame, ecefToEnu, geodeticToEnu, enuToEcefMatrix, Z_UP_TO_Y_UP, multiplyMatrices, getContentNodeMatrix };
export type { Vec3, Mat4, EnuFrame };

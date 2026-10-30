import { describe, it, expect } from 'vitest';
import { Axis, Cartesian3, Matrix4, Transforms } from '@cesium/engine';
import {
  createEnuFrame,
  ecefToEnu,
  enuToEcefMatrix,
  geodeticToEcef,
  geodeticToEnu,
  getContentNodeMatrix,
  Z_UP_TO_Y_UP,
  type Mat4,
  type Vec3,
} from '@src/tiling/enu';

const TOLERANCE = 1e-6;

// Axis exposes the axis conversion matrices at runtime, but they are missing from its typings
// eslint-disable-next-line @typescript-eslint/naming-convention -- Cesium names
const cesiumAxis = Axis as unknown as { Z_UP_TO_Y_UP: Matrix4; Y_UP_TO_Z_UP: Matrix4 };

const maxDifference = (actual: readonly number[], expected: readonly number[]): number => {
  if (actual.length !== expected.length) {
    return Infinity;
  }
  return Math.max(...actual.map((value, i) => Math.abs(value - (expected[i] as number))));
};

const applyMatrix = (matrix: Mat4, point: Vec3): Vec3 => {
  const result = Matrix4.multiplyByPoint(Matrix4.fromArray(matrix), new Cartesian3(...point), new Cartesian3());
  return [result.x, result.y, result.z];
};

const places = [
  { name: 'Tel Aviv', lon: 34.78, lat: 32.08, height: 40 },
  { name: 'Delft', lon: 4.36, lat: 52.01, height: 45 },
  { name: 'south of the equator, west of greenwich', lon: -70.25, lat: -33.45, height: 600 },
  { name: 'near the pole', lon: 120, lat: 89.5, height: 0 },
];

describe('enu', () => {
  describe.each(places)('at $name', ({ lon, lat, height }) => {
    it('should convert geodetic to ECEF like Cesium', () => {
      const expected = Cartesian3.fromDegrees(lon, lat, height);

      expect(maxDifference(geodeticToEcef(lon, lat, height), [expected.x, expected.y, expected.z])).toBeLessThan(TOLERANCE);
    });

    it('should build the same ENU to ECEF matrix as Cesium', () => {
      const expected = Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(lon, lat, 0));

      expect(maxDifference(enuToEcefMatrix(createEnuFrame(lon, lat)), Matrix4.toArray(expected))).toBeLessThan(TOLERANCE);
    });

    it('should build the same content node matrix as Cesium', () => {
      const enuToEcef = Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(lon, lat, 0));
      const expected = Matrix4.multiply(cesiumAxis.Z_UP_TO_Y_UP, enuToEcef, new Matrix4());

      expect(maxDifference(getContentNodeMatrix(createEnuFrame(lon, lat)), Matrix4.toArray(expected))).toBeLessThan(TOLERANCE);
    });

    it('should round trip a nearby point through ENU and back to ECEF', () => {
      const frame = createEnuFrame(lon, lat);
      const point = geodeticToEcef(lon + 0.003, lat - 0.002, height + 25);
      const enu = ecefToEnu(frame, point);

      expect(maxDifference(applyMatrix(enuToEcefMatrix(frame), enu), point)).toBeLessThan(TOLERANCE);
    });

    it('should place content where Cesium would after its Y-up to Z-up correction', () => {
      const frame = createEnuFrame(lon, lat);
      const enu = geodeticToEnu(frame, lon + 0.001, lat + 0.001, height);
      const nodeMatrix = getContentNodeMatrix(frame);
      const cesiumModelMatrix = Matrix4.multiply(cesiumAxis.Y_UP_TO_Z_UP, Matrix4.fromArray(nodeMatrix), new Matrix4());
      const world = Matrix4.multiplyByPoint(cesiumModelMatrix, new Cartesian3(...enu), new Cartesian3());
      const expected = Cartesian3.fromDegrees(lon + 0.001, lat + 0.001, height);

      expect(maxDifference([world.x, world.y, world.z], [expected.x, expected.y, expected.z])).toBeLessThan(TOLERANCE);
    });
  });

  it('should keep ENU offsets small so they fit float32 with sub-millimeter precision', () => {
    // a corner of a z14 tile (about 1.1 km wide) from its center
    const frame = createEnuFrame(34.78, 32.08);
    const enu = geodeticToEnu(frame, 34.78 + 0.0055, 32.08 + 0.0055, 100);
    const float32 = Float32Array.from(enu);
    enu.forEach((value, i) => expect(Math.abs(value - (float32[i] as number))).toBeLessThan(0.0001));
  });

  it('should match Cesium Z_UP_TO_Y_UP', () => {
    expect(maxDifference(Z_UP_TO_Y_UP, Matrix4.toArray(cesiumAxis.Z_UP_TO_Y_UP))).toBeLessThan(TOLERANCE);
  });
});

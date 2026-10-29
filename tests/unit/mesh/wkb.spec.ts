import { describe, it, expect } from 'vitest';
import { readWkbPolygons } from '@src/mesh/wkb';

const writeWkb = (littleEndian: boolean, type: number, body: (view: DataView, offset: number) => number, size: number): Uint8Array => {
  const buffer = new ArrayBuffer(size);
  const view = new DataView(buffer);
  view.setUint8(0, littleEndian ? 1 : 0);
  view.setUint32(1, type, littleEndian);
  const written = body(view, 5);

  expect(written).toBe(size);

  return new Uint8Array(buffer);
};

const writeRing = (view: DataView, offset: number, points: number[][], littleEndian: boolean): number => {
  view.setUint32(offset, points.length, littleEndian);
  let cursor = offset + 4;
  for (const point of points) {
    for (const value of point) {
      view.setFloat64(cursor, value, littleEndian);
      cursor += 8;
    }
  }
  return cursor;
};

const square = [
  [0, 0, 1],
  [1, 0, 1],
  [1, 1, 1],
  [0, 0, 1],
];

describe('wkb', () => {
  it('should read an ISO polygon Z and drop the closing point', () => {
    const wkb = writeWkb(
      true,
      1003,
      (view, offset) => {
        view.setUint32(offset, 1, true);
        return writeRing(view, offset + 4, square, true);
      },
      5 + 4 + 4 + 4 * 3 * 8
    );

    expect(readWkbPolygons(wkb)).toEqual([[[0, 0, 1, 1, 0, 1, 1, 1, 1]]]);
  });

  it('should read a big endian EWKB polygon with an SRID', () => {
    const ewkbPolygonZWithSrid = 0x80000000 | 0x20000000 | 3;
    const wkb = writeWkb(
      false,
      ewkbPolygonZWithSrid,
      (view, offset) => {
        view.setUint32(offset, 4326, false);
        view.setUint32(offset + 4, 1, false);
        return writeRing(view, offset + 8, square, false);
      },
      5 + 4 + 4 + 4 + 4 * 3 * 8
    );

    expect(readWkbPolygons(wkb)).toEqual([[[0, 0, 1, 1, 0, 1, 1, 1, 1]]]);
  });

  it('should read a 2D multi polygon with a zero Z', () => {
    const square2d = square.map(([x, y]) => [x as number, y as number]);
    const polygonSize = 5 + 4 + 4 + 4 * 2 * 8;
    const wkb = writeWkb(
      true,
      6,
      (view, offset) => {
        view.setUint32(offset, 2, true);
        let cursor = offset + 4;
        for (let i = 0; i < 2; i++) {
          view.setUint8(cursor, 1);
          view.setUint32(cursor + 1, 3, true);
          view.setUint32(cursor + 5, 1, true);
          cursor = writeRing(view, cursor + 9, square2d, true);
        }
        return cursor;
      },
      5 + 4 + 2 * polygonSize
    );

    expect(readWkbPolygons(wkb)).toHaveLength(2);
    expect(readWkbPolygons(wkb)[1]).toEqual([[0, 0, 0, 1, 0, 0, 1, 1, 0]]);
  });

  it('should throw on unsupported geometry types and trailing bytes', () => {
    const point = writeWkb(
      true,
      1,
      (view, offset) => {
        view.setFloat64(offset, 1, true);
        view.setFloat64(offset + 8, 2, true);
        return offset + 16;
      },
      21
    );

    expect(() => readWkbPolygons(point)).toThrow('unsupported WKB geometry type 1');

    const withTrailing = new Uint8Array(5 + 4 + 1);
    new DataView(withTrailing.buffer).setUint8(0, 1);
    new DataView(withTrailing.buffer).setUint32(1, 1006, true);

    expect(() => readWkbPolygons(withTrailing)).toThrow('trailing');
  });
});

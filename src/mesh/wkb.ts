import { readVec3 } from './vec3';

// A small reader for the WKB the worker gets from PostGIS (ST_AsBinary): polygons, multi polygons, TINs and triangles, with or
// without Z. Both ISO (type + 1000) and EWKB (high bit flag) Z markers are supported.

/**
 * A ring as a flat array of x, y, z triplets, without the closing point.
 */
type Ring = number[];

/**
 * A polygon as its outer ring followed by its holes.
 */
type PolygonRings = Ring[];

const WKB_POLYGON = 3;
const WKB_MULTI_POLYGON = 6;
const WKB_TIN = 16;
const WKB_TRIANGLE = 17;
const ISO_Z_OFFSET = 1000;
const ISO_M_OFFSET = 2000;
const ISO_ZM_OFFSET = 3000;
const EWKB_Z_FLAG = 0x80000000;
const EWKB_M_FLAG = 0x40000000;
const EWKB_SRID_FLAG = 0x20000000;
const EWKB_FLAGS_MASK = 0x0fffffff;
const UINT32_SIZE = 4;
const DOUBLE_SIZE = 8;
const BYTE_ORDER_LITTLE_ENDIAN = 1;
const XYZ = 3;

interface GeometryHeader {
  type: number;
  hasZ: boolean;
  hasM: boolean;
}

class WkbReader {
  private offset = 0;
  private littleEndian = true;

  public constructor(private readonly view: DataView) {}

  public readPolygons(): PolygonRings[] {
    const polygons: PolygonRings[] = [];
    this.readGeometry(polygons);
    if (this.offset !== this.view.byteLength) {
      throw new Error(`unexpected ${this.view.byteLength - this.offset} trailing bytes in WKB`);
    }
    return polygons;
  }

  private readGeometry(polygons: PolygonRings[]): void {
    const { type, hasZ, hasM } = this.readHeader();

    switch (type) {
      case WKB_POLYGON:
      case WKB_TRIANGLE:
        polygons.push(this.readPolygonBody(hasZ, hasM));
        break;
      case WKB_MULTI_POLYGON:
      case WKB_TIN: {
        const count = this.readUInt32();
        for (let i = 0; i < count; i++) {
          this.readGeometry(polygons);
        }
        break;
      }
      default:
        throw new Error(`unsupported WKB geometry type ${type}`);
    }
  }

  private readHeader(): GeometryHeader {
    this.littleEndian = this.view.getUint8(this.offset) === BYTE_ORDER_LITTLE_ENDIAN;
    this.offset += 1;
    const rawType = this.readUInt32();

    if ((rawType & ~EWKB_FLAGS_MASK) !== 0) {
      if ((rawType & EWKB_SRID_FLAG) !== 0) {
        this.offset += UINT32_SIZE;
      }
      return { type: rawType & EWKB_FLAGS_MASK, hasZ: (rawType & EWKB_Z_FLAG) !== 0, hasM: (rawType & EWKB_M_FLAG) !== 0 };
    }

    if (rawType >= ISO_ZM_OFFSET) {
      return { type: rawType - ISO_ZM_OFFSET, hasZ: true, hasM: true };
    }
    if (rawType >= ISO_M_OFFSET) {
      return { type: rawType - ISO_M_OFFSET, hasZ: false, hasM: true };
    }
    if (rawType >= ISO_Z_OFFSET) {
      return { type: rawType - ISO_Z_OFFSET, hasZ: true, hasM: false };
    }
    return { type: rawType, hasZ: false, hasM: false };
  }

  private readPolygonBody(hasZ: boolean, hasM: boolean): PolygonRings {
    const ringCount = this.readUInt32();
    const rings: PolygonRings = [];
    for (let i = 0; i < ringCount; i++) {
      rings.push(this.readRing(hasZ, hasM));
    }
    return rings;
  }

  private readRing(hasZ: boolean, hasM: boolean): Ring {
    const pointCount = this.readUInt32();
    const ring: Ring = [];
    for (let i = 0; i < pointCount; i++) {
      const x = this.readDouble();
      const y = this.readDouble();
      const z = hasZ ? this.readDouble() : 0;
      if (hasM) {
        this.offset += DOUBLE_SIZE;
      }
      ring.push(x, y, z);
    }

    // drop the closing point
    const last = ring.length - XYZ;
    if (last > 0 && readVec3(ring, 0).every((value, axis) => value === ring[last + axis])) {
      ring.length = last;
    }
    return ring;
  }

  private readUInt32(): number {
    const value = this.view.getUint32(this.offset, this.littleEndian);
    this.offset += UINT32_SIZE;
    return value;
  }

  private readDouble(): number {
    const value = this.view.getFloat64(this.offset, this.littleEndian);
    this.offset += DOUBLE_SIZE;
    return value;
  }
}

/**
 * Reads the polygons of a WKB Polygon, MultiPolygon, TIN or Triangle, in order.
 */
const readWkbPolygons = (wkb: Uint8Array): PolygonRings[] => {
  return new WkbReader(new DataView(wkb.buffer, wkb.byteOffset, wkb.byteLength)).readPolygons();
};

export { readWkbPolygons };
export type { Ring, PolygonRings };

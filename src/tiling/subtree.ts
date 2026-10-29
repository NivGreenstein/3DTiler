import type { ImplicitTile } from './grid';

// Subtree availability and the binary .subtree format of 3D Tiles 1.1 implicit tiling (quadtree).
// https://docs.ogc.org/cs/22-025r4/22-025r4.html#toc77

const QUADTREE_CHILDREN = 4;
const TILES_PER_AXIS_FACTOR = 2;
const MORTON_Y_BIT = 2;
const BITS_IN_BYTE = 8;
const SUBTREE_MAGIC = 0x74627573; // "subt"
const SUBTREE_VERSION = 1;
const SUBTREE_HEADER_LENGTH = 24;
const VERSION_OFFSET = 4;
const JSON_LENGTH_OFFSET = 8;
const BINARY_LENGTH_OFFSET = 16;
const ALIGNMENT = 8;
const JSON_PADDING = 0x20;

interface SubtreeAvailability {
  /**
   * One bit per tile of the subtree levels, level by level in Morton order.
   */
  tile: Uint8Array;
  content: Uint8Array;
  /**
   * One bit per tile of the level below the subtree, in Morton order.
   */
  childSubtree: Uint8Array;
  tileCount: number;
  childSubtreeCount: number;
}

/**
 * The number of tiles in the first `levels` levels of a quadtree.
 */
const countTilesInLevels = (levels: number): number => (QUADTREE_CHILDREN ** levels - 1) / (QUADTREE_CHILDREN - 1);

/**
 * Interleaves the bits of x and y, x in the least significant bit.
 */
const tilesPerAxis = (levels: number): number => TILES_PER_AXIS_FACTOR ** levels;

const mortonIndex = (x: number, y: number): number => {
  let index = 0;
  for (let bit = 0; x >= tilesPerAxis(bit) || y >= tilesPerAxis(bit); bit++) {
    const xBit = Math.floor(x / tilesPerAxis(bit)) % TILES_PER_AXIS_FACTOR;
    const yBit = Math.floor(y / tilesPerAxis(bit)) % TILES_PER_AXIS_FACTOR;
    index += (xBit + yBit * MORTON_Y_BIT) * QUADTREE_CHILDREN ** bit;
  }
  return index;
};

const setBit = (bits: Uint8Array, index: number): void => {
  const byte = Math.floor(index / BITS_IN_BYTE);
  bits[byte] = (bits[byte] as number) | (1 << (index % BITS_IN_BYTE));
};

const isBitSet = (bits: Uint8Array, index: number): boolean =>
  ((bits[Math.floor(index / BITS_IN_BYTE)] as number) & (1 << (index % BITS_IN_BYTE))) !== 0;

const createBitstream = (length: number): Uint8Array => new Uint8Array(Math.ceil(length / BITS_IN_BYTE));

/**
 * Computes the availability of a subtree.
 *
 * @param root - The subtree root
 * @param subtreeLevels - The number of levels in a subtree
 * @param tiles - Tiles that have content, at or below the root. Tiles below the subtree only mark the path to them as available.
 * @param forceRootAvailable - Makes the root tile available even without content below it, for the implicit tileset roots
 */
const computeSubtreeAvailability = (
  root: ImplicitTile,
  subtreeLevels: number,
  tiles: readonly ImplicitTile[],
  forceRootAvailable = false
): SubtreeAvailability => {
  const tileCount = countTilesInLevels(subtreeLevels);
  const childSubtreeCount = QUADTREE_CHILDREN ** subtreeLevels;
  const availability: SubtreeAvailability = {
    tile: createBitstream(tileCount),
    content: createBitstream(tileCount),
    childSubtree: createBitstream(childSubtreeCount),
    tileCount,
    childSubtreeCount,
  };

  const markAvailable = (tile: ImplicitTile, relativeLevel: number): void => {
    // the ancestor of the tile at every subtree level down to the given one
    for (let level = 0; level <= relativeLevel; level++) {
      const shift = tilesPerAxis(tile.level - root.level - level);
      const localX = Math.floor(tile.x / shift) - root.x * tilesPerAxis(level);
      const localY = Math.floor(tile.y / shift) - root.y * tilesPerAxis(level);
      setBit(availability.tile, countTilesInLevels(level) + mortonIndex(localX, localY));
    }
  };

  for (const tile of tiles) {
    const relativeLevel = tile.level - root.level;
    const span = tilesPerAxis(relativeLevel);
    const isInside =
      tile.hemisphere === root.hemisphere && relativeLevel >= 0 && Math.floor(tile.x / span) === root.x && Math.floor(tile.y / span) === root.y;
    if (!isInside) {
      throw new RangeError(`tile ${tile.hemisphere}/${tile.level}/${tile.x}/${tile.y} is not inside the subtree root`);
    }

    if (relativeLevel < subtreeLevels) {
      markAvailable(tile, relativeLevel);
      setBit(availability.content, countTilesInLevels(relativeLevel) + mortonIndex(tile.x - root.x * span, tile.y - root.y * span));
    } else {
      markAvailable(tile, subtreeLevels - 1);
      const shift = tilesPerAxis(relativeLevel - subtreeLevels);
      const childSpan = tilesPerAxis(subtreeLevels);
      const childX = Math.floor(tile.x / shift) - root.x * childSpan;
      const childY = Math.floor(tile.y / shift) - root.y * childSpan;
      setBit(availability.childSubtree, mortonIndex(childX, childY));
    }
  }

  if (forceRootAvailable) {
    setBit(availability.tile, 0);
  }

  return availability;
};

const countSetBits = (bits: Uint8Array, length: number): number => {
  let count = 0;
  for (let i = 0; i < length; i++) {
    if (isBitSet(bits, i)) {
      count++;
    }
  }
  return count;
};

const isRootAvailable = (availability: SubtreeAvailability): boolean => isBitSet(availability.tile, 0);

const align = (value: number): number => Math.ceil(value / ALIGNMENT) * ALIGNMENT;

/**
 * Encodes the availability as a binary .subtree file. Bitstreams that are all 0 or all 1 are written as constants.
 */
const writeSubtree = (availability: SubtreeAvailability): Buffer => {
  const parts: Buffer[] = [];
  const bufferViews: { buffer: number; byteOffset: number; byteLength: number }[] = [];
  let binaryLength = 0;

  const encode = (bits: Uint8Array, length: number): { constant: number } | { bitstream: number; availableCount: number } => {
    const availableCount = countSetBits(bits, length);
    if (availableCount === 0 || availableCount === length) {
      return { constant: availableCount === 0 ? 0 : 1 };
    }

    const byteOffset = align(binaryLength);
    if (byteOffset > binaryLength) {
      parts.push(Buffer.alloc(byteOffset - binaryLength));
    }
    parts.push(Buffer.from(bits));
    bufferViews.push({ buffer: 0, byteOffset, byteLength: bits.byteLength });
    binaryLength = byteOffset + bits.byteLength;
    return { bitstream: bufferViews.length - 1, availableCount };
  };

  const json: Record<string, unknown> = {
    tileAvailability: encode(availability.tile, availability.tileCount),
    contentAvailability: [encode(availability.content, availability.tileCount)],
    childSubtreeAvailability: encode(availability.childSubtree, availability.childSubtreeCount),
  };

  const paddedBinaryLength = align(binaryLength);
  if (paddedBinaryLength > binaryLength) {
    parts.push(Buffer.alloc(paddedBinaryLength - binaryLength));
  }
  if (bufferViews.length > 0) {
    json.buffers = [{ byteLength: paddedBinaryLength }];
    json.bufferViews = bufferViews;
  }

  const jsonBytes = Buffer.from(JSON.stringify(json), 'utf-8');
  const jsonBuffer = Buffer.alloc(align(jsonBytes.byteLength), JSON_PADDING);
  jsonBytes.copy(jsonBuffer);

  const header = Buffer.alloc(SUBTREE_HEADER_LENGTH);
  header.writeUInt32LE(SUBTREE_MAGIC, 0);
  header.writeUInt32LE(SUBTREE_VERSION, VERSION_OFFSET);
  header.writeBigUInt64LE(BigInt(jsonBuffer.byteLength), JSON_LENGTH_OFFSET);
  header.writeBigUInt64LE(BigInt(paddedBinaryLength), BINARY_LENGTH_OFFSET);

  return Buffer.concat([header, jsonBuffer, ...parts]);
};

export { computeSubtreeAvailability, writeSubtree, mortonIndex, countTilesInLevels, isRootAvailable, isBitSet };
export type { SubtreeAvailability };

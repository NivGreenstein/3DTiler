/* eslint-disable @typescript-eslint/naming-convention */ // glTF attribute names and metadata property names
import { FaceLabel } from '@src/building/models/building';
import type { Mat4 } from '@src/tiling/enu';
import type { TileFeature } from '@src/mesh/geometryBuilder/interfaces';
import type { TileMesh } from '@src/mesh/meshBuilder';

// Writes one content tile as a binary glTF 2.0 with one mesh primitive, per vertex feature ids (EXT_mesh_features), and a property
// table with the feature properties (EXT_structural_metadata). Vertex positions are in the tile ENU frame and the root node matrix
// places them on the globe.

// glTF constants
const GL_FLOAT = 5126;
const GL_UNSIGNED_BYTE = 5121;
const GL_UNSIGNED_SHORT = 5123;
const GL_UNSIGNED_INT = 5125;
const GL_ARRAY_BUFFER = 34962;
const GL_ELEMENT_ARRAY_BUFFER = 34963;
const GL_TRIANGLES = 4;

const GLB_MAGIC = 0x46546c67;
const GLB_VERSION = 2;
const GLB_HEADER_LENGTH = 12;
const GLB_CHUNK_HEADER_LENGTH = 8;
const CHUNK_TYPE_JSON = 0x4e4f534a;
const CHUNK_TYPE_BIN = 0x004e4942;
const CHUNK_ALIGNMENT = 4;
// EXT_structural_metadata requires property table buffer views to start at multiples of 8
const BUFFER_VIEW_ALIGNMENT = 8;
const JSON_PADDING = 0x20;
const MAX_UNSIGNED_SHORT_INDEX = 0xffff;
const RGBA = 4;
const NO_DATA_YEAR = -1;

const MESH_FEATURES = 'EXT_mesh_features';
const STRUCTURAL_METADATA = 'EXT_structural_metadata';
const SCHEMA_ID = 'tiler3d';
const BUILDING_CLASS = 'building';

type Rgba = [number, number, number, number];

/* eslint-disable @typescript-eslint/no-magic-numbers */ // colors
const FACE_COLORS: Record<FaceLabel, Rgba> = {
  [FaceLabel.GROUND]: [128, 128, 128, 255],
  [FaceLabel.ROOF]: [178, 74, 56, 255],
  [FaceLabel.OUTER_WALL]: [236, 230, 218, 255],
};
const UNKNOWN_FACE_COLOR: Rgba = [200, 200, 200, 255];
/* eslint-enable @typescript-eslint/no-magic-numbers */

interface GlbTile {
  mesh: TileMesh;
  features: TileFeature[];
  nodeMatrix: Mat4;
}

const align = (value: number, alignment: number): number => Math.ceil(value / alignment) * alignment;

class BinaryChunk {
  private readonly parts: Uint8Array[] = [];
  private byteLength = 0;
  private readonly bufferViews: Record<string, number>[] = [];

  public get views(): Record<string, number>[] {
    return this.bufferViews;
  }

  public addBufferView(data: ArrayBufferView, target?: number): number {
    const padding = align(this.byteLength, BUFFER_VIEW_ALIGNMENT) - this.byteLength;
    if (padding > 0) {
      this.parts.push(new Uint8Array(padding));
      this.byteLength += padding;
    }

    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    this.parts.push(bytes);
    this.bufferViews.push({ buffer: 0, byteOffset: this.byteLength, byteLength: bytes.byteLength, ...(target !== undefined ? { target } : {}) });
    this.byteLength += bytes.byteLength;
    return this.bufferViews.length - 1;
  }

  public toBuffer(): Buffer {
    const buffer = Buffer.alloc(align(this.byteLength, CHUNK_ALIGNMENT));
    let offset = 0;
    for (const part of this.parts) {
      buffer.set(part, offset);
      offset += part.byteLength;
    }
    return buffer;
  }
}

const encodeStrings = (values: string[]): { values: Uint8Array; offsets: Uint32Array } => {
  const encoded = values.map((value) => Buffer.from(value, 'utf-8'));
  const offsets = new Uint32Array(values.length + 1);
  encoded.forEach((bytes, i) => {
    offsets[i + 1] = (offsets[i] as number) + bytes.byteLength;
  });
  return { values: Buffer.concat(encoded), offsets };
};

const getVertexColors = (labels: Uint8Array): Uint8Array => {
  const colors = new Uint8Array(labels.length * RGBA);
  labels.forEach((label, i) => {
    colors.set((FACE_COLORS as Partial<Record<number, Rgba>>)[label] ?? UNKNOWN_FACE_COLOR, i * RGBA);
  });
  return colors;
};

const writeChunk = (type: number, data: Buffer): Buffer => {
  const header = Buffer.alloc(GLB_CHUNK_HEADER_LENGTH);
  header.writeUInt32LE(data.byteLength, 0);
  header.writeUInt32LE(type, CHUNK_ALIGNMENT);
  return Buffer.concat([header, data]);
};

/**
 * Encodes a content tile as GLB.
 */
const writeGlb = ({ mesh, features, nodeMatrix }: GlbTile): Buffer => {
  const bin = new BinaryChunk();
  const useShortIndices = mesh.vertexCount <= MAX_UNSIGNED_SHORT_INDEX;

  const positionView = bin.addBufferView(mesh.positions, GL_ARRAY_BUFFER);
  const normalView = bin.addBufferView(mesh.normals, GL_ARRAY_BUFFER);
  const colorView = bin.addBufferView(getVertexColors(mesh.labels), GL_ARRAY_BUFFER);
  const featureIdView = bin.addBufferView(mesh.featureIds, GL_ARRAY_BUFFER);
  const indexView = bin.addBufferView(useShortIndices ? Uint16Array.from(mesh.indices) : mesh.indices, GL_ELEMENT_ARRAY_BUFFER);

  // a buffer view can not be empty, so a string property whose values are all empty is left out of the table, which reads as noData
  const stringProperty = (values: string[]): Record<string, unknown> | undefined => {
    const encoded = encodeStrings(values);
    if (encoded.values.byteLength === 0) {
      return undefined;
    }
    return { values: bin.addBufferView(encoded.values), stringOffsets: bin.addBufferView(encoded.offsets), stringOffsetType: 'UINT32' };
  };

  const propertyTable = {
    class: BUILDING_CLASS,
    count: features.length,
    properties: {
      id: stringProperty(features.map((f) => f.id)),
      building_id: stringProperty(features.map((f) => f.buildingId)),
      height: { values: bin.addBufferView(Float32Array.from(features.map((f) => f.height))) },
      ground_height: { values: bin.addBufferView(Float32Array.from(features.map((f) => f.groundHeight))) },
      construction_year: { values: bin.addBufferView(Int16Array.from(features.map((f) => f.constructionYear ?? NO_DATA_YEAR))) },
      roof_type: stringProperty(features.map((f) => f.roofType ?? '')),
    },
  };

  const binBuffer = bin.toBuffer();

  const gltf = {
    asset: { version: '2.0', generator: '3dtiler' },
    extensionsUsed: [MESH_FEATURES, STRUCTURAL_METADATA],
    extensions: {
      [STRUCTURAL_METADATA]: {
        schema: {
          id: SCHEMA_ID,
          classes: {
            [BUILDING_CLASS]: {
              name: 'Building',
              properties: {
                id: { type: 'STRING', description: 'The building part id' },
                building_id: { type: 'STRING', description: 'The building id in the source' },
                height: { type: 'SCALAR', componentType: 'FLOAT32', description: 'The height from the ground to the top, in meters' },
                ground_height: { type: 'SCALAR', componentType: 'FLOAT32', description: 'The ground height above the WGS84 ellipsoid, in meters' },
                construction_year: { type: 'SCALAR', componentType: 'INT16', noData: NO_DATA_YEAR },
                roof_type: { type: 'STRING', noData: '' },
              },
            },
          },
        },
        propertyTables: [propertyTable],
      },
    },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, matrix: nodeMatrix }],
    meshes: [
      {
        primitives: [
          {
            attributes: { POSITION: 0, NORMAL: 1, COLOR_0: 2, _FEATURE_ID_0: 3 },
            indices: 4,
            material: 0,
            mode: GL_TRIANGLES,
            extensions: { [MESH_FEATURES]: { featureIds: [{ featureCount: features.length, attribute: 0, propertyTable: 0 }] } },
          },
        ],
      },
    ],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 1 }, doubleSided: true }],
    accessors: [
      { bufferView: positionView, componentType: GL_FLOAT, count: mesh.vertexCount, type: 'VEC3', min: mesh.min, max: mesh.max },
      { bufferView: normalView, componentType: GL_FLOAT, count: mesh.vertexCount, type: 'VEC3' },
      { bufferView: colorView, componentType: GL_UNSIGNED_BYTE, normalized: true, count: mesh.vertexCount, type: 'VEC4' },
      { bufferView: featureIdView, componentType: GL_FLOAT, count: mesh.vertexCount, type: 'SCALAR' },
      { bufferView: indexView, componentType: useShortIndices ? GL_UNSIGNED_SHORT : GL_UNSIGNED_INT, count: mesh.indices.length, type: 'SCALAR' },
    ],
    bufferViews: bin.views,
    buffers: [{ byteLength: binBuffer.byteLength }],
  };

  const json = Buffer.from(JSON.stringify(gltf), 'utf-8');
  const jsonBuffer = Buffer.alloc(align(json.byteLength, CHUNK_ALIGNMENT), JSON_PADDING);
  json.copy(jsonBuffer);

  const body = Buffer.concat([writeChunk(CHUNK_TYPE_JSON, jsonBuffer), writeChunk(CHUNK_TYPE_BIN, binBuffer)]);
  const header = Buffer.alloc(GLB_HEADER_LENGTH);
  header.writeUInt32LE(GLB_MAGIC, 0);
  header.writeUInt32LE(GLB_VERSION, CHUNK_ALIGNMENT);
  header.writeUInt32LE(GLB_HEADER_LENGTH + body.byteLength, GLB_CHUNK_HEADER_LENGTH);
  return Buffer.concat([header, body]);
};

export { writeGlb, FACE_COLORS };
export type { GlbTile };

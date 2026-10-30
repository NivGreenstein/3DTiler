/* eslint-disable @typescript-eslint/naming-convention */ // glTF extension names
import { describe, it, expect } from 'vitest';
import { validateBytes } from 'gltf-validator';
import { writeGlb } from '@src/glb/glbWriter';
import { MeshBuilder } from '@src/mesh/meshBuilder';
import { triangulateFace } from '@src/mesh/triangulate';
import { createEnuFrame, getContentNodeMatrix } from '@src/tiling/enu';
import type { TileFeature } from '@src/mesh/geometryBuilder/interfaces';

const buildBox = (meshBuilder: MeshBuilder, featureId: number, x: number, size: number, height: number): void => {
  const [w, e, s, n] = [x, x + size, 0, size];
  const faces: [number, number[]][] = [
    [0, [w, s, 0, w, n, 0, e, n, 0, e, s, 0]],
    [1, [w, s, height, e, s, height, e, n, height, w, n, height]],
    [2, [w, s, 0, e, s, 0, e, s, height, w, s, height]],
    [2, [e, s, 0, e, n, 0, e, n, height, e, s, height]],
    [2, [e, n, 0, w, n, 0, w, n, height, e, n, height]],
    [2, [w, n, 0, w, s, 0, w, s, height, w, n, height]],
  ];
  for (const [label, ring] of faces) {
    const face = triangulateFace([ring]);
    if (face !== undefined) {
      meshBuilder.addFace(featureId, label, face.vertices, face.indices, face.normal);
    }
  }
};

const readJson = (glb: Buffer): Record<string, unknown> => {
  const jsonLength = glb.readUInt32LE(12);
  return JSON.parse(glb.subarray(20, 20 + jsonLength).toString('utf-8')) as Record<string, unknown>;
};

const features: TileFeature[] = [
  { id: 'NL.IMBAG.Pand.1-0', buildingId: 'NL.IMBAG.Pand.1', height: 12.5, groundHeight: 116, constructionYear: 1932, roofType: 'slanted' },
  { id: 'NL.IMBAG.Pand.2-0', buildingId: 'NL.IMBAG.Pand.2', height: 4, groundHeight: 117, constructionYear: null, roofType: null },
];

describe('glbWriter', () => {
  const meshBuilder = new MeshBuilder();
  buildBox(meshBuilder, 0, 0, 10, 12.5);
  buildBox(meshBuilder, 1, 20, 6, 4);
  const mesh = meshBuilder.build();
  const glb = writeGlb({ mesh, features, nodeMatrix: getContentNodeMatrix(createEnuFrame(5.838, 50.858)) });

  it('should write a GLB that the Khronos glTF validator accepts without errors or warnings', async () => {
    const report = await validateBytes(new Uint8Array(glb));

    expect(report.issues.numErrors).toBe(0);
    expect(report.issues.numWarnings).toBe(0);
    expect(report.info?.totalVertexCount).toBe(mesh.vertexCount);
  });

  it('should have a valid GLB header and 4 byte aligned chunks', () => {
    expect(glb.readUInt32LE(0)).toBe(0x46546c67);
    expect(glb.readUInt32LE(4)).toBe(2);
    expect(glb.readUInt32LE(8)).toBe(glb.byteLength);
    expect(glb.readUInt32LE(12) % 4).toBe(0);
  });

  it('should declare one feature id per feature and a property table with every feature', () => {
    const json = readJson(glb) as {
      meshes: { primitives: { extensions: { EXT_mesh_features: { featureIds: { featureCount: number; propertyTable: number }[] } } }[] }[];
      extensions: { EXT_structural_metadata: { propertyTables: { count: number; properties: Record<string, unknown> }[] } };
      nodes: { matrix: number[] }[];
    };

    expect(json.meshes[0]?.primitives[0]?.extensions.EXT_mesh_features.featureIds).toEqual([{ featureCount: 2, attribute: 0, propertyTable: 0 }]);

    const [table] = json.extensions.EXT_structural_metadata.propertyTables;

    expect(table?.count).toBe(2);
    expect(Object.keys(table?.properties ?? {})).toEqual(['id', 'building_id', 'height', 'ground_height', 'construction_year', 'roof_type']);
    expect(json.nodes[0]?.matrix).toHaveLength(16);
  });

  it('should leave out a string property whose values are all empty, since a buffer view can not be empty', async () => {
    const withoutRoofTypes = features.map((feature) => ({ ...feature, roofType: null }));
    const glbWithoutRoofTypes = writeGlb({ mesh, features: withoutRoofTypes, nodeMatrix: getContentNodeMatrix(createEnuFrame(34.78, 32.08)) });

    const report = await validateBytes(new Uint8Array(glbWithoutRoofTypes));
    const json = readJson(glbWithoutRoofTypes) as {
      extensions: { EXT_structural_metadata: { propertyTables: { properties: Record<string, unknown> }[] } };
    };

    expect(report.issues.numErrors).toBe(0);
    expect(json.extensions.EXT_structural_metadata.propertyTables[0]?.properties).not.toHaveProperty('roof_type');
  });

  it('should align every buffer view to 8 bytes', () => {
    const json = readJson(glb) as { bufferViews: { byteOffset: number }[] };

    for (const view of json.bufferViews) {
      expect(view.byteOffset % 8).toBe(0);
    }
  });
});

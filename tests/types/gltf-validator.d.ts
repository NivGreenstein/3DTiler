declare module 'gltf-validator' {
  interface ValidationReport {
    issues: {
      numErrors: number;
      numWarnings: number;
      numInfos: number;
      messages: { code: string; message: string; severity: number; pointer?: string }[];
    };
    info?: { totalVertexCount?: number; totalTriangleCount?: number };
  }

  export function validateBytes(data: Uint8Array, options?: Record<string, unknown>): Promise<ValidationReport>;
}

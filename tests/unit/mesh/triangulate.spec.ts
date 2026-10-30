import { describe, it, expect } from 'vitest';
import { computeNewellNormal, triangulateFace } from '@src/mesh/triangulate';

const area = (vertices: number[], indices: number[]): number => {
  let sum = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const [a, b, c] = [indices[i] as number, indices[i + 1] as number, indices[i + 2] as number].map((v) => vertices.slice(v * 3, v * 3 + 3)) as [
      number[],
      number[],
      number[],
    ];
    const u = [(b[0] as number) - (a[0] as number), (b[1] as number) - (a[1] as number), (b[2] as number) - (a[2] as number)];
    const v = [(c[0] as number) - (a[0] as number), (c[1] as number) - (a[1] as number), (c[2] as number) - (a[2] as number)];
    sum +=
      Math.hypot(
        (u[1] as number) * (v[2] as number) - (u[2] as number) * (v[1] as number),
        (u[2] as number) * (v[0] as number) - (u[0] as number) * (v[2] as number),
        (u[0] as number) * (v[1] as number) - (u[1] as number) * (v[0] as number)
      ) / 2;
  }
  return sum;
};

describe('triangulate', () => {
  describe('#computeNewellNormal', () => {
    it('should point up for a counter clockwise ring seen from above', () => {
      expect(computeNewellNormal([0, 0, 5, 2, 0, 5, 2, 2, 5, 0, 2, 5])).toEqual([0, 0, 1]);
    });

    it('should return undefined for a degenerate ring', () => {
      expect(computeNewellNormal([0, 0, 0, 1, 1, 1, 2, 2, 2])).toBeUndefined();
    });
  });

  describe('#triangulateFace', () => {
    it('should triangulate a vertical wall facing south', () => {
      // seen from the south (negative y) the ring is counter clockwise
      const face = triangulateFace([[0, 0, 0, 4, 0, 0, 4, 0, 3, 0, 0, 3]]);

      expect(face?.normal).toEqual([0, -1, 0]);
      expect(face?.indices).toHaveLength(6);
      expect(area(face?.vertices as number[], face?.indices as number[])).toBeCloseTo(12);
    });

    it('should cut holes and wind every triangle like the face', () => {
      const outer = [0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0];
      const hole = [4, 4, 0, 4, 6, 0, 6, 6, 0, 6, 4, 0];

      const face = triangulateFace([outer, hole]);

      expect(area(face?.vertices as number[], face?.indices as number[])).toBeCloseTo(96);

      const vertices = face?.vertices as number[];
      const indices = face?.indices as number[];
      for (let i = 0; i < indices.length; i += 3) {
        const [a, b, c] = [indices[i] as number, indices[i + 1] as number, indices[i + 2] as number];
        const signedArea =
          ((vertices[b * 3] as number) - (vertices[a * 3] as number)) * ((vertices[c * 3 + 1] as number) - (vertices[a * 3 + 1] as number)) -
          ((vertices[c * 3] as number) - (vertices[a * 3] as number)) * ((vertices[b * 3 + 1] as number) - (vertices[a * 3 + 1] as number));

        expect(signedArea).toBeGreaterThan(0);
      }
    });

    it('should triangulate a sloped roof face', () => {
      const face = triangulateFace([[0, 0, 0, 10, 0, 0, 10, 5, 5, 0, 5, 5]]);

      expect(face?.normal[1]).toBeCloseTo(-Math.SQRT1_2);
      expect(face?.normal[2]).toBeCloseTo(Math.SQRT1_2);
      expect(area(face?.vertices as number[], face?.indices as number[])).toBeCloseTo(10 * Math.hypot(5, 5));
    });

    it('should return undefined for degenerate faces', () => {
      expect(triangulateFace([])).toBeUndefined();
      expect(triangulateFace([[0, 0, 0, 1, 1, 1]])).toBeUndefined();
      expect(triangulateFace([[0, 0, 0, 1, 1, 1, 2, 2, 2]])).toBeUndefined();
    });
  });
});

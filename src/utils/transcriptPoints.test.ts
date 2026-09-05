import { describe, expect, it } from "vitest";
import {
  decodeTranscriptPoints,
  encodeTranscriptPoints,
} from "./transcriptPoints";

describe("decodeTranscriptPoints", () => {
  it("round-trips level-0 points with quality", () => {
    const decoded = decodeTranscriptPoints(
      encodeTranscriptPoints({
        x: [1.5, 3.5],
        y: [2.5, 4.5],
        gene: [0, 1],
        quality: [30, 15],
      }),
    );
    expect(decoded.count).toBe(2);
    expect(Array.from(decoded.x)).toEqual([1.5, 3.5]);
    expect(Array.from(decoded.y)).toEqual([2.5, 4.5]);
    expect(Array.from(decoded.gene)).toEqual([0, 1]);
    expect(Array.from(decoded.quality!)).toEqual([30, 15]);
  });

  it("leaves quality null at coarser levels", () => {
    const decoded = decodeTranscriptPoints(
      encodeTranscriptPoints({ x: [1], y: [2], gene: [3] }),
    );
    expect(decoded.count).toBe(1);
    expect(decoded.quality).toBeNull();
  });

  it("decodes an empty body and rejects a truncated one", () => {
    expect(
      decodeTranscriptPoints(encodeTranscriptPoints({ x: [], y: [], gene: [] }))
        .count,
    ).toBe(0);
    const full = encodeTranscriptPoints({ x: [1], y: [2], gene: [0] });
    expect(() => decodeTranscriptPoints(full.slice(0, 10))).toThrow(
      /expected 14/,
    );
    expect(() => decodeTranscriptPoints(new ArrayBuffer(2))).toThrow(
      /truncated/,
    );
  });
});

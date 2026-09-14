import { ITranscriptPoints } from "@/store/model";

/**
 * Decode the binary body of `POST spatial/{datasetId}/transcripts/points`
 * (SPATIAL_PLUGIN.md, Phase 3):
 *
 *     uint32 n, uint8 hasQuality,
 *     float32[n*2] x,y (image pixels), uint8[n] gene slot,
 *     then when hasQuality (level 0): float32[n] quality.
 *
 * Little-endian. Typed-array views need aligned offsets, and the 5-byte
 * header leaves the float block unaligned, so the arrays are copied out
 * with `slice` — cheaper than a DataView loop and still one pass.
 */
export function decodeTranscriptPoints(buffer: ArrayBuffer): ITranscriptPoints {
  if (buffer.byteLength < 5) {
    throw new Error("transcript points body is truncated");
  }
  const header = new DataView(buffer, 0, 5);
  const count = header.getUint32(0, true);
  const hasQuality = header.getUint8(4) === 1;
  const expected = 5 + count * (8 + 1) + (hasQuality ? count * 4 : 0);
  if (buffer.byteLength !== expected) {
    throw new Error(
      `transcript points body is ${buffer.byteLength} bytes, expected ${expected}`,
    );
  }
  let offset = 5;
  const xy = new Float32Array(buffer.slice(offset, offset + count * 8));
  offset += count * 8;
  const gene = new Uint8Array(buffer.slice(offset, offset + count));
  offset += count;
  const x = new Float32Array(count);
  const y = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    x[i] = xy[2 * i];
    y[i] = xy[2 * i + 1];
  }
  const quality = hasQuality
    ? new Float32Array(buffer.slice(offset, offset + count * 4))
    : null;
  return { count, x, y, gene, quality };
}

/** Encode points the way the server does; the decoder's test twin and a
 * fixture builder for overlay tests. */
export function encodeTranscriptPoints(points: {
  x: ArrayLike<number>;
  y: ArrayLike<number>;
  gene: ArrayLike<number>;
  quality?: ArrayLike<number> | null;
}): ArrayBuffer {
  const count = points.x.length;
  const hasQuality = points.quality != null;
  const buffer = new ArrayBuffer(5 + count * 9 + (hasQuality ? count * 4 : 0));
  const view = new DataView(buffer);
  view.setUint32(0, count, true);
  view.setUint8(4, hasQuality ? 1 : 0);
  let offset = 5;
  for (let i = 0; i < count; i++) {
    view.setFloat32(offset, points.x[i], true);
    view.setFloat32(offset + 4, points.y[i], true);
    offset += 8;
  }
  for (let i = 0; i < count; i++) {
    view.setUint8(offset++, points.gene[i]);
  }
  if (hasQuality) {
    for (let i = 0; i < count; i++) {
      view.setFloat32(offset, points.quality![i], true);
      offset += 4;
    }
  }
  return buffer;
}

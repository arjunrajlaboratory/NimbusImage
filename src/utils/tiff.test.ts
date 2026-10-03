import { describe, it, expect } from "vitest";
import { parseRawTiff } from "./tiff";

// Build a minimal uncompressed 3x2 uint16 TIFF with one strip per row,
// in either byte order
function buildTiff(littleEndian: boolean): ArrayBuffer {
  const entries = 9;
  const ifdOffset = 8;
  const ifdSize = 2 + entries * 12 + 4;
  const stripOffsetsOffset = ifdOffset + ifdSize;
  const stripByteCountsOffset = stripOffsetsOffset + 8;
  const dataOffset = stripByteCountsOffset + 8;
  const buffer = new ArrayBuffer(dataOffset + 12);
  const view = new DataView(buffer);

  view.setUint16(0, littleEndian ? 0x4949 : 0x4d4d, false);
  view.setUint16(2, 42, littleEndian);
  view.setUint32(4, ifdOffset, littleEndian);

  let entryOffset = ifdOffset + 2;
  const writeEntry = (
    tag: number,
    type: number,
    count: number,
    value: number,
  ) => {
    view.setUint16(entryOffset, tag, littleEndian);
    view.setUint16(entryOffset + 2, type, littleEndian);
    view.setUint32(entryOffset + 4, count, littleEndian);
    if (type === 3 && count === 1) {
      // SHORT values are left-justified in the 4-byte value field
      view.setUint16(entryOffset + 8, value, littleEndian);
    } else {
      view.setUint32(entryOffset + 8, value, littleEndian);
    }
    entryOffset += 12;
  };

  view.setUint16(ifdOffset, entries, littleEndian);
  writeEntry(256, 3, 1, 3); // ImageWidth
  writeEntry(257, 3, 1, 2); // ImageLength
  writeEntry(258, 3, 1, 16); // BitsPerSample
  writeEntry(259, 3, 1, 1); // Compression: none
  writeEntry(273, 4, 2, stripOffsetsOffset); // StripOffsets
  writeEntry(277, 3, 1, 1); // SamplesPerPixel
  writeEntry(278, 3, 1, 1); // RowsPerStrip
  writeEntry(279, 4, 2, stripByteCountsOffset); // StripByteCounts
  writeEntry(339, 3, 1, 1); // SampleFormat: unsigned integer
  view.setUint32(entryOffset, 0, littleEndian); // no next IFD

  view.setUint32(stripOffsetsOffset, dataOffset, littleEndian);
  view.setUint32(stripOffsetsOffset + 4, dataOffset + 6, littleEndian);
  view.setUint32(stripByteCountsOffset, 6, littleEndian);
  view.setUint32(stripByteCountsOffset + 4, 6, littleEndian);

  const pixels = [10, 20, 30, 40, 50, 60];
  pixels.forEach((value, i) => {
    view.setUint16(dataOffset + 2 * i, value, littleEndian);
  });
  return buffer;
}

describe("parseRawTiff", () => {
  it.each([
    ["little-endian", true],
    ["big-endian", false],
  ])("parses a striped uncompressed uint16 %s TIFF", (_, littleEndian) => {
    const result = parseRawTiff(buildTiff(littleEndian));
    expect(result.width).toBe(3);
    expect(result.height).toBe(2);
    expect(result.samplesPerPixel).toBe(1);
    expect(result.data).toBeInstanceOf(Uint16Array);
    expect(Array.from(result.data)).toEqual([10, 20, 30, 40, 50, 60]);
  });

  it("rejects non-TIFF data", () => {
    expect(() => parseRawTiff(new ArrayBuffer(16))).toThrow(/byte order/);
  });

  it("rejects compressed TIFFs", () => {
    const buffer = buildTiff(true);
    const view = new DataView(buffer);
    // Compression tag is the 4th IFD entry; overwrite its value with LZW (5)
    view.setUint16(8 + 2 + 3 * 12 + 8, 5, true);
    expect(() => parseRawTiff(buffer)).toThrow(/compression/i);
  });
});

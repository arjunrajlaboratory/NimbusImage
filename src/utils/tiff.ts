// Minimal reader for the uncompressed (compression=1) striped TIFF files that
// large_image returns from `/item/{id}/tiles/region` when called with
// `encoding=TIFF&tiffCompression=raw`. This is not a general TIFF reader: it
// rejects compressed, tiled, planar and BigTIFF files, which large_image never
// produces for that request.

export type TRawPixels =
  | Uint8Array
  | Uint16Array
  | Uint32Array
  | Int8Array
  | Int16Array
  | Int32Array
  | Float32Array
  | Float64Array;

export interface IRawImageData {
  width: number;
  height: number;
  samplesPerPixel: number;
  // Interleaved samples, row-major: data[(y * width + x) * samplesPerPixel + s]
  data: TRawPixels;
}

const enum TiffTag {
  ImageWidth = 256,
  ImageLength = 257,
  BitsPerSample = 258,
  Compression = 259,
  StripOffsets = 273,
  SamplesPerPixel = 277,
  RowsPerStrip = 278,
  StripByteCounts = 279,
  PlanarConfiguration = 284,
  SampleFormat = 339,
}

const enum TiffFieldType {
  Byte = 1,
  Short = 3,
  Long = 4,
}

const fieldTypeSize: { [type: number]: number } = {
  [TiffFieldType.Byte]: 1,
  [TiffFieldType.Short]: 2,
  [TiffFieldType.Long]: 4,
};

// SampleFormat tag values from the TIFF specification
const enum TiffSampleFormat {
  UnsignedInteger = 1,
  SignedInteger = 2,
  Float = 3,
}

function readTagValues(
  view: DataView,
  entryOffset: number,
  littleEndian: boolean,
): number[] | null {
  const type = view.getUint16(entryOffset + 2, littleEndian);
  const count = view.getUint32(entryOffset + 4, littleEndian);
  const size = fieldTypeSize[type];
  if (size === undefined) {
    // Unsupported field type (rational, ascii, ...): callers don't need them
    return null;
  }
  const valuesOffset =
    size * count <= 4
      ? entryOffset + 8
      : view.getUint32(entryOffset + 8, littleEndian);
  const values: number[] = [];
  for (let i = 0; i < count; i++) {
    const offset = valuesOffset + i * size;
    switch (type) {
      case TiffFieldType.Byte:
        values.push(view.getUint8(offset));
        break;
      case TiffFieldType.Short:
        values.push(view.getUint16(offset, littleEndian));
        break;
      case TiffFieldType.Long:
        values.push(view.getUint32(offset, littleEndian));
        break;
    }
  }
  return values;
}

function createPixelArray(
  sampleFormat: number,
  bitsPerSample: number,
  count: number,
): TRawPixels {
  if (sampleFormat === TiffSampleFormat.Float) {
    switch (bitsPerSample) {
      case 32:
        return new Float32Array(count);
      case 64:
        return new Float64Array(count);
    }
  } else if (sampleFormat === TiffSampleFormat.SignedInteger) {
    switch (bitsPerSample) {
      case 8:
        return new Int8Array(count);
      case 16:
        return new Int16Array(count);
      case 32:
        return new Int32Array(count);
    }
  } else if (sampleFormat === TiffSampleFormat.UnsignedInteger) {
    switch (bitsPerSample) {
      case 8:
        return new Uint8Array(count);
      case 16:
        return new Uint16Array(count);
      case 32:
        return new Uint32Array(count);
    }
  }
  throw new Error(
    `Unsupported TIFF pixel type: sample format ${sampleFormat}, ${bitsPerSample} bits per sample`,
  );
}

/**
 * Parse an uncompressed striped TIFF buffer into a typed array of samples.
 *
 * @param buffer The raw TIFF file contents.
 * @returns Dimensions and interleaved sample values of the image.
 */
export function parseRawTiff(buffer: ArrayBuffer): IRawImageData {
  const view = new DataView(buffer);
  const byteOrder = view.getUint16(0, false);
  let littleEndian: boolean;
  if (byteOrder === 0x4949) {
    littleEndian = true;
  } else if (byteOrder === 0x4d4d) {
    littleEndian = false;
  } else {
    throw new Error("Not a TIFF file: bad byte order mark");
  }
  if (view.getUint16(2, littleEndian) !== 42) {
    throw new Error("Not a TIFF file: bad magic number");
  }

  const ifdOffset = view.getUint32(4, littleEndian);
  const entryCount = view.getUint16(ifdOffset, littleEndian);
  const tags: Map<number, number[]> = new Map();
  for (let i = 0; i < entryCount; i++) {
    const entryOffset = ifdOffset + 2 + i * 12;
    const tag = view.getUint16(entryOffset, littleEndian);
    const values = readTagValues(view, entryOffset, littleEndian);
    if (values !== null) {
      tags.set(tag, values);
    }
  }

  const width = tags.get(TiffTag.ImageWidth)?.[0];
  const height = tags.get(TiffTag.ImageLength)?.[0];
  const stripOffsets = tags.get(TiffTag.StripOffsets);
  const stripByteCounts = tags.get(TiffTag.StripByteCounts);
  if (!width || !height || !stripOffsets || !stripByteCounts) {
    throw new Error("TIFF file is missing required tags");
  }
  const compression = tags.get(TiffTag.Compression)?.[0] ?? 1;
  if (compression !== 1) {
    throw new Error(`Unsupported TIFF compression: ${compression}`);
  }
  const planarConfiguration = tags.get(TiffTag.PlanarConfiguration)?.[0] ?? 1;
  if (planarConfiguration !== 1) {
    throw new Error("Unsupported TIFF planar configuration");
  }
  const samplesPerPixel = tags.get(TiffTag.SamplesPerPixel)?.[0] ?? 1;
  const bitsPerSample = tags.get(TiffTag.BitsPerSample)?.[0] ?? 8;
  const sampleFormat =
    tags.get(TiffTag.SampleFormat)?.[0] ?? TiffSampleFormat.UnsignedInteger;

  const sampleCount = width * height * samplesPerPixel;
  const data = createPixelArray(sampleFormat, bitsPerSample, sampleCount);
  const bytesPerSample = bitsPerSample / 8;

  // Concatenate the strips into a contiguous sample buffer
  let sampleIndex = 0;
  for (let strip = 0; strip < stripOffsets.length; strip++) {
    const stripSamples = Math.min(
      stripByteCounts[strip] / bytesPerSample,
      sampleCount - sampleIndex,
    );
    let offset = stripOffsets[strip];
    for (let i = 0; i < stripSamples; i++, offset += bytesPerSample) {
      let value: number;
      switch (bytesPerSample) {
        case 1:
          value =
            sampleFormat === TiffSampleFormat.SignedInteger
              ? view.getInt8(offset)
              : view.getUint8(offset);
          break;
        case 2:
          value =
            sampleFormat === TiffSampleFormat.SignedInteger
              ? view.getInt16(offset, littleEndian)
              : view.getUint16(offset, littleEndian);
          break;
        case 4:
          value =
            sampleFormat === TiffSampleFormat.Float
              ? view.getFloat32(offset, littleEndian)
              : sampleFormat === TiffSampleFormat.SignedInteger
                ? view.getInt32(offset, littleEndian)
                : view.getUint32(offset, littleEndian);
          break;
        default:
          value = view.getFloat64(offset, littleEndian);
      }
      data[sampleIndex++] = value;
    }
  }

  return { width, height, samplesPerPixel, data };
}

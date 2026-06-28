import vtkDataArray from "@kitware/vtk.js/Common/Core/DataArray";
import vtkImageData, {
  vtkImageData as VtkImageData,
} from "@kitware/vtk.js/Common/DataModel/ImageData";
import type { AxiosRequestConfig } from "axios";
import pLimit from "p-limit";
import type { RestClientInstance } from "@/girder";
import { inferZStepFromDimensionLabelsUm } from "@/utils/dimensionLabels";
import { logWarning } from "@/utils/log";
import { medianPositiveSpacing } from "@/utils/stats";
import {
  IDataset,
  IDisplayLayer,
  IDisplaySlice,
  IImage,
  ILayerStackImage,
  TVolumeAxis,
} from "@/store/model";
import {
  ITileHistogram,
  ITileOptions,
  mergeHistograms,
  toStyle,
} from "@/store/images";

export interface VolumeGeometry {
  unit: "um";
  spacing: [number, number, number];
  origin: [number, number, number];
  dimensions: [number, number, number];
  sourceSize: [number, number];
  // How many original depth planes each rendered voxel represents (>1 when the
  // depth axis was subsampled to fit the cap). Used to place annotations.
  // Optional for back-compat; treated as 1 when absent.
  depthStride?: number;
}

export interface ChannelVolume {
  layer: IDisplayLayer;
  imageData: VtkImageData;
  geometry: VolumeGeometry;
}

export interface VolumeRequest {
  dataset: IDataset;
  layers: ILayerStackImage[];
  xy: number;
  // Current z and time indices. Whichever axis is NOT mapped to the volume
  // depth (see `axis`) is held fixed at its current index.
  z: number;
  time: number;
  // Which dataset axis becomes the volume's 3rd dimension. Defaults to "z".
  axis?: TVolumeAxis;
  zStepUmOverride?: number | null;
  // Depth spacing (µm) to use when axis === "t". null/undefined → 5× pixel size.
  timeStepUmOverride?: number | null;
  maxXYDimension?: number;
  maxDepth?: number;
  scalarMemoryBudgetBytes?: number;
}

export interface VolumeSource {
  buildVolume(
    params: VolumeRequest,
    signal?: AbortSignal,
  ): Promise<ChannelVolume[]>;
}

interface ITileFrameVolumeSourceOptions {
  concurrency?: number;
  maxXYDimension?: number;
  maxDepth?: number;
  scalarMemoryBudgetBytes?: number;
  // How many depth frames to sample when estimating the whole-cube intensity
  // range for percentile contrast windowing.
  histogramSampleCount?: number;
}

interface IResolvedLayer {
  layerStackImage: ILayerStackImage;
  xyValue: number;
  // Resolved current z and time. The axis mapped to depth iterates over all of
  // its values; the other stays fixed at the value resolved here.
  zValue: number;
  timeValue: number;
  channelValue: number;
}

const defaultOptions: Required<ITileFrameVolumeSourceOptions> = {
  concurrency: 5,
  maxXYDimension: 512,
  // Cap the depth (z/time) count. Keeps the GPU 3D texture under common WebGL2
  // limits (~2048) and bounds the number of frame fetches. Deeper stacks are
  // subsampled (every Nth plane).
  maxDepth: 512,
  scalarMemoryBudgetBytes: 128 * 1024 * 1024,
  histogramSampleCount: 24,
};

// Evenly sample up to `count` items from a list (returns all if fewer).
function sampleEvenly<T>(items: T[], count: number): T[] {
  if (items.length <= count) {
    return items;
  }
  const result: T[] = [];
  for (let index = 0; index < count; index += 1) {
    result.push(items[Math.floor((index * items.length) / count)]);
  }
  return result;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new DOMException("Volume build aborted", "AbortError");
  }
}

function resolveSliceValue(
  slice: IDisplaySlice,
  values: number[],
  currentIndex: number,
): number | null {
  if (values.length <= 1) {
    return values[0] ?? null;
  }
  let index = currentIndex;
  if (slice.type === "constant") {
    index = slice.value ?? 0;
  } else if (slice.type === "offset") {
    index = currentIndex + (slice.value ?? 0);
  }
  return index >= 0 && index < values.length ? values[index] : null;
}

function resolveVisibleLayers(
  request: VolumeRequest,
  axis: TVolumeAxis,
): IResolvedLayer[] {
  return request.layers.flatMap((layerStackImage) => {
    const { layer } = layerStackImage;
    if (!layer.visible) {
      return [];
    }
    const xyValue = resolveSliceValue(layer.xy, request.dataset.xy, request.xy);
    const channelValue = request.dataset.channels[layer.channel];
    if (xyValue === null || channelValue === undefined) {
      return [];
    }
    // The depth axis iterates over all of its values, so its slice need not
    // resolve (it is frequently "max-merge"). Only the fixed (non-depth) axis
    // must resolve to a single index.
    if (axis === "z") {
      const timeValue = resolveSliceValue(
        layer.time,
        request.dataset.time,
        request.time,
      );
      if (timeValue === null) {
        return [];
      }
      return [{ layerStackImage, xyValue, zValue: 0, timeValue, channelValue }];
    }
    const zValue = resolveSliceValue(layer.z, request.dataset.z, request.z);
    if (zValue === null) {
      return [];
    }
    return [{ layerStackImage, xyValue, zValue, timeValue: 0, channelValue }];
  });
}

function makeFrameStyle(
  layer: IDisplayLayer,
  histogram: ITileHistogram | null,
  frame: number,
): ITileOptions {
  const style = toStyle("#ffffff", layer.contrast, histogram, null, null, null);
  if ("bands" in style) {
    return {
      min: "min",
      max: "max",
      palette: ["#000000", "#ffffff"],
      frame,
    };
  }
  return { ...style, palette: ["#000000", "#ffffff"], frame };
}

function inferZStepFromFramePositionsUm(dataset: IDataset): number | null {
  const framePositions = dataset.z
    .map(
      (zValue) =>
        dataset.allImages.find((image) => image.key.z === zValue)?.frame
          .PositionZ,
    )
    .filter(
      (position): position is number =>
        position !== undefined && Number.isFinite(position),
    );
  return medianPositiveSpacing(framePositions);
}

function inferZStepFromOverrideUm(override?: number | null): number | null {
  if (override === undefined || override === null || override <= 0) {
    return null;
  }
  if (override < 1_000_000) {
    return override;
  }
  logWarning("Ignoring implausibly large z-step override for 3D volume");
  return null;
}

function inferZStepUm(dataset: IDataset, override?: number | null): number {
  // An explicit user override wins over auto-inference.
  const fromOverride = inferZStepFromOverrideUm(override);
  if (fromOverride !== null && fromOverride > 0) {
    return fromOverride;
  }

  const fromLabels = inferZStepFromDimensionLabelsUm(dataset.dimensionLabels);
  if (fromLabels !== null && fromLabels > 0) {
    return fromLabels;
  }

  const fromFramePositions = inferZStepFromFramePositionsUm(dataset);
  if (fromFramePositions !== null && fromFramePositions > 0) {
    return fromFramePositions;
  }

  const anyImage = dataset.anyImage();
  const fallback =
    anyImage && anyImage.mm_x > 0 && anyImage.mm_y > 0
      ? ((anyImage.mm_x + anyImage.mm_y) / 2) * 1000
      : 1;
  logWarning(
    `Unable to infer z spacing for 3D volume; using ${fallback} um fallback`,
  );
  return fallback;
}

// Physical pixel size in µm. Falls back to 1 unit/pixel when the source has no
// calibration (mm_x/mm_y missing or zero) so the volume still has non-zero
// extent — otherwise vtk renders an empty (invisible) volume.
function effectivePixelSizeUm(image: IImage): [number, number] {
  const x = image.mm_x > 0 ? image.mm_x * 1000 : 1;
  const y = image.mm_y > 0 ? image.mm_y * 1000 : 1;
  return [x, y];
}

// Time has no physical micrometer extent, so when time is the depth axis the
// spacing between timepoints is a display choice. Default to 5× the xy pixel
// size (a reasonable "slightly stretched" look); honor an explicit override.
const DEFAULT_TIME_STEP_PIXEL_MULTIPLE = 5;

// The auto default time depth spacing for an image. Exported so the UI can show
// and prefill the same value the renderer uses.
export function defaultTimeStepUm(image: IImage): number {
  const [pixelUmX, pixelUmY] = effectivePixelSizeUm(image);
  return ((pixelUmX + pixelUmY) / 2) * DEFAULT_TIME_STEP_PIXEL_MULTIPLE;
}

function inferTimeStepUm(image: IImage, override?: number | null): number {
  if (override !== undefined && override !== null && override > 0) {
    return override;
  }
  return defaultTimeStepUm(image);
}

function chooseFetchedSize(
  sourceWidth: number,
  sourceHeight: number,
  zCount: number,
  channelCount: number,
  maxXYDimension: number,
  scalarMemoryBudgetBytes: number,
): [number, number] {
  const perChannelBudget = scalarMemoryBudgetBytes / Math.max(channelCount, 1);
  const memoryScale = Math.sqrt(
    perChannelBudget / Math.max(sourceWidth * sourceHeight * zCount, 1),
  );
  const maxDimensionScale =
    maxXYDimension / Math.max(sourceWidth, sourceHeight);
  const scale = Math.min(1, memoryScale, maxDimensionScale);
  return [
    Math.max(1, Math.floor(sourceWidth * scale)),
    Math.max(1, Math.floor(sourceHeight * scale)),
  ];
}

async function decodePngToGrayscale(
  blob: Blob,
  width: number,
  height: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  throwIfAborted(signal);
  const bitmap = await createImageBitmap(blob);
  throwIfAborted(signal);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    bitmap.close();
    throw new Error("Could not create canvas context for volume frame decode");
  }
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const rgba = context.getImageData(0, 0, width, height).data;
  const gray = new Uint8Array(width * height);
  for (let index = 0; index < gray.length; index += 1) {
    gray[index] = rgba[index * 4];
  }
  return gray;
}

export class TileFrameVolumeSource implements VolumeSource {
  private readonly client: RestClientInstance;
  private readonly options: Required<ITileFrameVolumeSourceOptions>;

  constructor(
    client: RestClientInstance,
    options: ITileFrameVolumeSourceOptions = {},
  ) {
    this.client = client;
    this.options = { ...defaultOptions, ...options };
  }

  // Whole-cube intensity range for percentile windowing: sample depth frames,
  // fetch each one's histogram, and merge to min-of-mins / max-of-maxs. This
  // makes the volume windowing independent of which single z/t the navigator
  // is on (a per-frame histogram would shift the whole volume as you scrub).
  private async fetchCubeHistogram(
    images: IImage[],
    limit: <T>(fn: () => Promise<T>) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<ITileHistogram | null> {
    const sampled = sampleEvenly(images, this.options.histogramSampleCount);
    if (sampled.length === 0) {
      return null;
    }
    const histograms = await Promise.all(
      sampled.map((image) =>
        limit(async () => {
          throwIfAborted(signal);
          const response = await this.client.get(
            `item/${image.item._id}/tiles/histogram`,
            {
              params: {
                frame: image.frameIndex,
                bins: 256,
                width: 1024,
                height: 1024,
                resample: false,
              },
              signal,
            },
          );
          return response.data[0] as ITileHistogram;
        }),
      ),
    );
    return mergeHistograms(histograms);
  }

  private async fetchFrame(
    image: IImage,
    layer: IDisplayLayer,
    histogram: ITileHistogram | null,
    width: number,
    height: number,
    signal?: AbortSignal,
  ) {
    const params = {
      left: 0,
      top: 0,
      right: image.sizeX,
      bottom: image.sizeY,
      width,
      height,
      encoding: "PNG",
      frame: image.frameIndex,
      style: JSON.stringify(makeFrameStyle(layer, histogram, image.frameIndex)),
    };
    const config: AxiosRequestConfig = {
      params,
      responseType: "blob",
      signal,
    };
    const response = await this.client.get<Blob>(
      `item/${image.item._id}/tiles/region`,
      config,
    );
    return decodePngToGrayscale(response.data, width, height, signal);
  }

  async buildVolume(
    request: VolumeRequest,
    signal?: AbortSignal,
  ): Promise<ChannelVolume[]> {
    throwIfAborted(signal);
    const axis = request.axis ?? "z";
    const resolvedLayers = resolveVisibleLayers(request, axis);
    if (resolvedLayers.length === 0) {
      return [];
    }

    const maxXYDimension =
      request.maxXYDimension ?? this.options.maxXYDimension;
    const scalarMemoryBudgetBytes =
      request.scalarMemoryBudgetBytes ?? this.options.scalarMemoryBudgetBytes;
    const allAxisValues =
      axis === "z" ? request.dataset.z : request.dataset.time;
    // Cap the depth: subsample to every Nth plane/timepoint so the GPU 3D
    // texture stays under WebGL limits and the fetch count stays bounded.
    const maxDepth = request.maxDepth ?? this.options.maxDepth;
    const depthStride = Math.max(1, Math.ceil(allAxisValues.length / maxDepth));
    const axisValues = allAxisValues.filter(
      (_value, index) => index % depthStride === 0,
    );
    if (depthStride > 1) {
      logWarning(
        `3D volume depth subsampled: showing every ${depthStride} ` +
          `${axis === "z" ? "z-planes" : "timepoints"} ` +
          `(${axisValues.length}/${allAxisValues.length})`,
      );
    }
    // Only infer z spacing when z is the depth axis, so time mode never logs a
    // spurious "unable to infer z spacing" warning.
    const zStepUm =
      axis === "z" ? inferZStepUm(request.dataset, request.zStepUmOverride) : 0;
    const limit = pLimit(this.options.concurrency);

    return Promise.all(
      resolvedLayers.map(async (resolvedLayer) => {
        const { layerStackImage, xyValue, zValue, timeValue, channelValue } =
          resolvedLayer;
        const sourceImages = axisValues.map((axisValue) => {
          const zForFrame = axis === "z" ? axisValue : zValue;
          const timeForFrame = axis === "z" ? timeValue : axisValue;
          return (
            request.dataset.images(
              zForFrame,
              timeForFrame,
              xyValue,
              channelValue,
            )[0] ?? null
          );
        });
        const firstImage = sourceImages.find(
          (image): image is IImage => image !== null,
        );
        if (!firstImage) {
          logWarning(
            `No frames found for 3D volume layer ${layerStackImage.layer.name}`,
          );
          throwIfAborted(signal);
          return null;
        }

        const depthCount = axisValues.length;
        const [fetchedWidth, fetchedHeight] = chooseFetchedSize(
          firstImage.sizeX,
          firstImage.sizeY,
          depthCount,
          resolvedLayers.length,
          maxXYDimension,
          scalarMemoryBudgetBytes,
        );
        if (
          fetchedWidth !== firstImage.sizeX ||
          fetchedHeight !== firstImage.sizeY
        ) {
          logWarning(
            `3D volume layer ${layerStackImage.layer.name} downsampled from ` +
              `${firstImage.sizeX}x${firstImage.sizeY} to ` +
              `${fetchedWidth}x${fetchedHeight}`,
          );
        }

        const perPlaneSpacingUm =
          axis === "z"
            ? zStepUm
            : inferTimeStepUm(firstImage, request.timeStepUmOverride);
        // Subsampled voxels are `depthStride` original planes apart.
        const thirdSpacingUm = perPlaneSpacingUm * depthStride;
        const [pixelUmX, pixelUmY] = effectivePixelSizeUm(firstImage);
        const geometry: VolumeGeometry = {
          unit: "um",
          spacing: [
            pixelUmX * (firstImage.sizeX / fetchedWidth),
            pixelUmY * (firstImage.sizeY / fetchedHeight),
            thirdSpacingUm,
          ],
          origin: [0, 0, 0],
          dimensions: [fetchedWidth, fetchedHeight, depthCount],
          sourceSize: [firstImage.sizeX, firstImage.sizeY],
          depthStride,
        };
        const scalarData = new Uint8Array(
          fetchedWidth * fetchedHeight * depthCount,
        );

        // Percentile contrast needs a histogram; absolute contrast ignores it.
        // Use a whole-cube range so windowing is independent of the current z/t.
        const cubeHistogram =
          layerStackImage.layer.contrast.mode === "absolute"
            ? null
            : await this.fetchCubeHistogram(
                sourceImages.filter((image): image is IImage => image !== null),
                limit,
                signal,
              );

        await Promise.all(
          sourceImages.map((image, depthIndex) =>
            limit(async () => {
              throwIfAborted(signal);
              if (!image) {
                logWarning(
                  `Missing ${axis}=${axisValues[depthIndex]} frame for 3D ` +
                    `volume layer ${layerStackImage.layer.name}`,
                );
                return;
              }
              const plane = await this.fetchFrame(
                image,
                layerStackImage.layer,
                cubeHistogram,
                fetchedWidth,
                fetchedHeight,
                signal,
              );
              scalarData.set(plane, depthIndex * fetchedWidth * fetchedHeight);
            }),
          ),
        );

        const imageData = vtkImageData.newInstance();
        imageData.setDimensions(geometry.dimensions);
        imageData.setSpacing(geometry.spacing);
        imageData.setOrigin(geometry.origin);
        imageData.getPointData().setScalars(
          vtkDataArray.newInstance({
            name: layerStackImage.layer.name,
            numberOfComponents: 1,
            values: scalarData,
          }),
        );

        throwIfAborted(signal);
        return {
          layer: layerStackImage.layer,
          imageData,
          geometry,
        };
      }),
    ).then((volumes) =>
      volumes.filter((volume): volume is ChannelVolume => volume !== null),
    );
  }
}

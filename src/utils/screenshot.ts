import {
  ITileOptionsBands,
  getBandOption,
  getLayerImages,
  type ITileHistogram,
} from "@/store/images";
import {
  IDataset,
  IDatasetLocation,
  IDisplayLayer,
  IDownloadParameters,
  IGeoJSBounds,
  type IImage,
} from "@/store/model";

// The selected layers can't be rendered at this location (none selected, or a
// layer has no plane there). Typed so callers rendering many locations (the
// montage) can tell this expected case from a real failure.
export class LayerSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LayerSelectionError";
  }
}

// Mirrors MAX_RAW_REGION_BYTES in the plugin's server/api/rawRegion.py: the
// raw_region endpoint refuses outputs with more sample bytes than this.
export const RAW_REGION_MAX_BYTES = 64 * 1024 * 1024;

const BYTES_PER_SAMPLE: { [dtype: string]: number } = {
  uint8: 1,
  int8: 1,
  uint16: 2,
  int16: 2,
  float16: 2,
  uint32: 4,
  int32: 4,
  float32: 4,
};

/**
 * The most pixels a raw_region TIFF of this image can hold, so raw crops are
 * downsampled to the server's byte budget rather than refused. Unknown dtypes
 * and band counts get the server's widest assumption (four 8-byte bands).
 */
export function rawRegionMaxPixels(tileinfo: {
  dtype?: string;
  bandCount?: number;
}): number {
  const bytesPerPixel =
    (BYTES_PER_SAMPLE[tileinfo.dtype ?? ""] ?? 8) * (tileinfo.bandCount || 4);
  return Math.floor(RAW_REGION_MAX_BYTES / bytesPerPixel);
}

/**
 * The largest per-side size, at most `maxDim`, of a square raw_region request
 * that fits the byte budget: what callers that cap both sides (the line scan)
 * should pass as their maximum dimension.
 */
export function rawRegionMaxDim(
  tileinfo: { dtype?: string; bandCount?: number },
  maxDim: number,
): number {
  return Math.min(maxDim, Math.floor(Math.sqrt(rawRegionMaxPixels(tileinfo))));
}

export function getDownloadParameters(
  bounds: IGeoJSBounds,
  format: string,
  maxPixels: number,
  jpegQuality: number,
): IDownloadParameters {
  if (
    ![bounds.left, bounds.top, bounds.right, bounds.bottom].every(
      Number.isFinite,
    ) ||
    bounds.right <= bounds.left ||
    bounds.bottom <= bounds.top
  ) {
    throw new Error("Snapshot crop must have a positive width and height.");
  }
  // Larger crops are downsampled to maxPixels. Raw-channel TIFFs keep their
  // dtype, but downsampled pixels may come from a lower-resolution level of
  // the image, where values can be averaged.
  const regionWidth = bounds.right - bounds.left;
  const regionHeight = bounds.bottom - bounds.top;
  const scale = Math.min(
    1,
    Math.sqrt(maxPixels / (regionWidth * regionHeight)),
  );
  const params: IDownloadParameters = {
    encoding: format.toUpperCase(),
    contentDisposition: "attachment",
    ...bounds,
    width:
      scale < 1 ? Math.max(1, Math.floor(scale * regionWidth)) : regionWidth,
    height:
      scale < 1 ? Math.max(1, Math.floor(scale * regionHeight)) : regionHeight,
  };
  if (format === "jpeg") {
    params.jpegQuality = jpegQuality;
  } else if (format === "tiff") {
    params.tiffCompression = "raw";
  }
  return params;
}

// `tiles/region` renders styled images and converts 16-bit data to 8 bits;
// `raw_region` returns one frame's samples unscaled as a TIFF. It ignores the
// encoding, style and contentDisposition parameters (downloads are named
// client-side from contentDispositionFilename).
export function getBaseURLFromDownloadParameters(
  params: IDownloadParameters,
  itemId: string,
  apiRoot: string,
  endpoint: "tiles/region" | "raw_region" = "tiles/region",
) {
  const baseUrl = new URL(`${apiRoot}/item/${itemId}/${endpoint}`);
  for (const [key, value] of Object.entries(params)) {
    baseUrl.searchParams.set(key, value);
  }
  return baseUrl;
}

export async function getLayersDownloadUrls(
  baseUrl: URL,
  exportLayer: "all" | "composite" | string,
  configurationLayers: IDisplayLayer[],
  dataset: IDataset,
  location: IDatasetLocation,
  api: { getLayerHistogram(images: IImage[]): Promise<ITileHistogram | null> },
) {
  const layers = configurationLayers.filter(
    (layer) =>
      exportLayer === "all" ||
      (exportLayer === "composite" ? layer.visible : layer.id === exportLayer),
  );
  if (layers.length === 0) {
    throw new LayerSelectionError("No layers selected for download.");
  }
  // A style without a frame defaults to frame zero on the server. Validate
  // before requesting any histograms so missing planes cannot be mislabeled.
  for (const layer of layers) {
    if (
      !getLayerImages(layer, dataset, location.time, location.xy, location.z)
        .length
    ) {
      throw new LayerSelectionError(
        `No image for layer ${layer.name} at XY${location.xy + 1}, T${location.time + 1}, Z${location.z + 1}.`,
      );
    }
  }
  const styles = await Promise.all(
    layers.map(async (layer) => ({
      layerId: layer.id,
      style: await getBandOption(dataset, layer, location, api),
    })),
  );

  // Return one URL per band or a single URL with all bands
  if (exportLayer === "all") {
    const urls: { url: URL; layerIds: string[] }[] = [];
    for (const { layerId, style } of styles) {
      const url = new URL(baseUrl);
      url.searchParams.set("style", JSON.stringify(style));
      urls.push({ url, layerIds: [layerId] });
    }
    return urls;
  } else {
    const url = new URL(baseUrl);
    const layerIds: string[] = [];
    const combinedStyle: ITileOptionsBands = {
      bands: styles.reduce(
        (currentBands: ITileOptionsBands["bands"], { layerId, style }) => {
          if ("bands" in style) {
            currentBands.push(...style.bands);
          } else {
            currentBands.push(style);
          }
          layerIds.push(layerId);
          return currentBands;
        },
        [],
      ),
    };
    url.searchParams.set("style", JSON.stringify(combinedStyle));
    return [{ url, layerIds }];
  }
}

export function getChannelsDownloadUrls(
  baseUrl: URL,
  exportChannel: "all" | number,
  dataset: IDataset,
  location: IDatasetLocation,
) {
  const datasetChannels = dataset.channels;
  let channelsToDownload: number[];
  if (exportChannel === "all") {
    channelsToDownload = datasetChannels;
  } else {
    channelsToDownload = [exportChannel];
  }
  const urls: { url: URL; channel: number }[] = [];
  const { xy, z, time } = location;
  for (const channel of channelsToDownload) {
    // Locations contain slider indices; raw channel selections already contain
    // dataset channel IDs (unlike a display layer's channel index).
    const image = dataset.images(
      dataset.z[z],
      dataset.time[time],
      dataset.xy[xy],
      channel,
    )[0];
    if (!image) {
      const channelName =
        dataset.channelNames.get(channel) ?? "Unknown channel";
      throw new Error(`Image not found for channel ${channelName}`);
    }
    // Don't modify the base url
    const url = new URL(baseUrl);
    url.searchParams.set("frame", image.frameIndex.toString());
    urls.push({ url, channel });
  }
  return urls;
}

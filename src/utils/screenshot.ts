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

export function getDownloadParameters(
  bounds: IGeoJSBounds,
  format: string,
  maxPixels: number,
  jpegQuality: number,
  downloadMode: "layers" | "channels",
) {
  if (
    ![bounds.left, bounds.top, bounds.right, bounds.bottom].every(
      Number.isFinite,
    ) ||
    bounds.right <= bounds.left ||
    bounds.bottom <= bounds.top
  ) {
    throw new Error("Snapshot crop must have a positive width and height.");
  }
  const params: IDownloadParameters = {
    encoding: format.toUpperCase(),
    contentDisposition: "attachment",
    ...bounds,
    width: bounds.right - bounds.left,
    height: bounds.bottom - bounds.top,
  };
  if (format === "jpeg") {
    params.jpeqQuality = jpegQuality;
  } else if (format === "tiff") {
    params.tiffCompression = "raw";
  }

  // Maximum 4M pixels per image
  if (params.width && params.height) {
    const nPixels = params.width * params.height;
    if (nPixels > maxPixels) {
      if (downloadMode === "layers") {
        // Scale the image
        const scale = Math.sqrt(maxPixels / nPixels);
        params.width = Math.floor(scale * params.width);
        params.height = Math.floor(scale * params.height);
      } else if (downloadMode === "channels") {
        // Don't scale when in "channels" mode
        return null;
      }
    }
  }
  return params;
}

export function getBaseURLFromDownloadParameters(
  params: IDownloadParameters,
  itemId: string,
  apiRoot: string,
) {
  const baseUrl = new URL(`${apiRoot}/item/${itemId}/tiles/region`);
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
  if (layers.length === 0) throw new Error("No layers selected for download.");
  // A style without a frame defaults to frame zero on the server. Validate
  // before requesting any histograms so missing planes cannot be mislabeled.
  for (const layer of layers) {
    if (
      !getLayerImages(layer, dataset, location.time, location.xy, location.z)
        .length
    ) {
      throw new Error(
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

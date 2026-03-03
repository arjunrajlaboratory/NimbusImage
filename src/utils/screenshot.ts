import {
  ITileOptions,
  ITileOptionsBands,
  getBandOption,
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
  // Get layer bands: style and frame idx
  const styles: { style: ITileOptions; layerId: string }[] = [];
  const promises: Promise<any>[] = [];
  if (exportLayer === "composite" || exportLayer === "all") {
    configurationLayers.forEach((layer) => {
      if (layer.visible || exportLayer === "all") {
        promises.push(
          getBandOption(dataset, layer, location, api).then((style) =>
            styles.push({ layerId: layer.id, style }),
          ),
        );
      }
    });
  } else {
    const layerId = exportLayer;
    const layer = configurationLayers.find((layer) => layer.id === layerId);
    if (!layer) {
      return [];
    }
    promises.push(
      getBandOption(dataset, layer, location, api).then((style) =>
        styles.push({ layerId: layer.id, style }),
      ),
    );
  }
  await Promise.all(promises);

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
    const image = dataset.images(z, time, xy, channel)[0];
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

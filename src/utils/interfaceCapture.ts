import html2canvas from "html2canvas";
import { IChatImage, IGeoJSMap } from "@/store/model";
import { logError } from "@/utils/log";

// Screenshot helpers shared between the chat assistant (ChatComponent.vue) and
// the automatic tool-suggestion flow (store/toolSuggestions.ts). Both need to
// send Claude a picture of the whole interface plus a picture of just the
// image in the viewport.
//
// NOTE: ChatComponent.vue currently has its own copies of the first two
// functions. It predates this util; a follow-up could switch it over to these
// to remove the duplication.

/**
 * Capture the whole application interface as a PNG data URL.
 *
 * @param ignoreElement Optional element whose subtree should be excluded from
 *   the capture (e.g. a floating chat panel that shouldn't appear in its own
 *   screenshot).
 */
export async function captureInterfaceScreenshot(
  ignoreElement?: HTMLElement | null,
): Promise<IChatImage | null> {
  try {
    const canvas = await html2canvas(document.body, {
      ignoreElements: (element) =>
        !!ignoreElement &&
        (element === ignoreElement || ignoreElement.contains(element)),
    });
    return {
      data: canvas.toDataURL("image/png"),
      type: "image/png",
      visible: false,
    };
  } catch (error) {
    logError("Error capturing interface screenshot:", error);
    return null;
  }
}

/**
 * Capture just the rendered image from a GeoJS map, skipping hidden layers.
 */
export async function captureViewportScreenshot(
  map: IGeoJSMap | undefined,
): Promise<IChatImage | null> {
  if (!map) {
    return null;
  }
  try {
    const layers = map
      .layers()
      .filter((layer: any) => layer.node().css("visibility") !== "hidden");
    const image = await map.screenshot(layers);
    return { data: image, type: "image/png", visible: false };
  } catch (error) {
    logError("Error capturing viewport screenshot:", error);
    return null;
  }
}

/**
 * Split a `data:` URL into the pieces the Claude API expects: a media type and
 * the bare base64 payload (no `data:...;base64,` prefix).
 */
export function dataUrlToBase64(
  dataUrl: string,
): { media_type: string; data: string } | null {
  const match = dataUrl.match(/data:([a-zA-Z0-9]+\/[a-zA-Z0-9-.+]+).*,(.*)/);
  if (match?.length === 3) {
    const [, media_type, data] = match;
    return { media_type, data };
  }
  return null;
}

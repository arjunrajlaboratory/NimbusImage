import type { IAnnotationOverviewConfig } from "@/store/model";
import { clamp } from "@/utils/math";

export const ANNOTATION_OVERVIEW_HYSTERESIS = 0.15;
export const ANNOTATION_OVERVIEW_OPACITY_BOUNDS = { min: 0, max: 1 };
export const ANNOTATION_OVERVIEW_THRESHOLD_BOUNDS = { min: 0.1, max: 16 };
const ANNOTATION_OVERVIEW_NAVIGATION_SCALE = 0.95;

function stableStringHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * Select a bounded, repeatable pseudo-random sample without materializing the
 * input. The same ordered input produces the same sample, so redraws do not
 * make raster-mode selection indicators visibly reshuffle.
 */
export function stableRandomSampleById<T>(
  items: Iterable<T>,
  limit: number,
  getId: (item: T) => string,
): T[] {
  const boundedLimit = Math.max(0, Math.floor(limit));
  if (boundedLimit === 0) {
    return [];
  }

  const sample: T[] = [];
  let itemsSeen = 0;
  for (const item of items) {
    itemsSeen += 1;
    if (sample.length < boundedLimit) {
      sample.push(item);
      continue;
    }

    const replacementIndex = stableStringHash(getId(item)) % itemsSeen;
    if (replacementIndex < boundedLimit) {
      sample[replacementIndex] = item;
    }
  }
  return sample;
}

export function annotationOverviewRasterActive(options: {
  config: IAnnotationOverviewConfig;
  unitsPerPixel: number;
  wasActive: boolean;
  unrolling: boolean;
}): boolean {
  const { config, unitsPerPixel, wasActive, unrolling } = options;
  if (!config.enabled || unrolling) {
    return false;
  }
  const threshold = clamp(
    config.vectorSwitchThreshold,
    ANNOTATION_OVERVIEW_THRESHOLD_BOUNDS.min,
    ANNOTATION_OVERVIEW_THRESHOLD_BOUNDS.max,
  );
  const rasterThreshold = wasActive
    ? threshold
    : threshold * (1 + ANNOTATION_OVERVIEW_HYSTERESIS);
  return unitsPerPixel > rasterThreshold;
}

/**
 * Return the zoom that puts the viewer just inside the vector-visible range.
 * The small margin avoids landing on the switch boundary due to floating-point
 * or map synchronization differences.
 */
export function zoomForVectorAnnotations(options: {
  currentZoom: number;
  unitsPerPixel: number;
  vectorSwitchThreshold: number;
  maxZoom?: number;
}): number | null {
  const { currentZoom, unitsPerPixel, vectorSwitchThreshold, maxZoom } =
    options;
  const threshold = clamp(
    vectorSwitchThreshold,
    ANNOTATION_OVERVIEW_THRESHOLD_BOUNDS.min,
    ANNOTATION_OVERVIEW_THRESHOLD_BOUNDS.max,
  );
  if (!Number.isFinite(unitsPerPixel) || unitsPerPixel <= threshold) {
    return null;
  }
  const zoom =
    currentZoom +
    Math.log2(
      unitsPerPixel / (threshold * ANNOTATION_OVERVIEW_NAVIGATION_SCALE),
    );
  return maxZoom === undefined ? zoom : Math.min(zoom, maxZoom);
}

export function clampAnnotationOverviewConfig(
  config: IAnnotationOverviewConfig,
): IAnnotationOverviewConfig {
  return {
    ...config,
    opacity: clamp(
      config.opacity,
      ANNOTATION_OVERVIEW_OPACITY_BOUNDS.min,
      ANNOTATION_OVERVIEW_OPACITY_BOUNDS.max,
    ),
    vectorSwitchThreshold: clamp(
      config.vectorSwitchThreshold,
      ANNOTATION_OVERVIEW_THRESHOLD_BOUNDS.min,
      ANNOTATION_OVERVIEW_THRESHOLD_BOUNDS.max,
    ),
  };
}

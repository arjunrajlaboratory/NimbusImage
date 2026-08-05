import type { IAnnotationOverviewConfig } from "@/store/model";
import { clamp } from "@/utils/math";

export const ANNOTATION_OVERVIEW_HYSTERESIS = 0.15;
export const ANNOTATION_OVERVIEW_OPACITY_BOUNDS = { min: 0, max: 1 };
export const ANNOTATION_OVERVIEW_THRESHOLD_BOUNDS = { min: 0.1, max: 16 };

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

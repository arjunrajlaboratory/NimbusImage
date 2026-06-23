// Bounds + clamping for the annotation-rendering visibility settings.
//
// `visibilityConfig` is power-user-tunable in UISettings.vue. The settings UI
// lets a user type any number, so we need a single source of truth for the
// allowed range of each field and a pure function that snaps an attempted
// change into a legal config (absolute floor/ceiling per field, plus the two
// cross-field invariants: you can't draw more shapes than visible features, and
// the hydration cache must be at least as large as one refresh's hydration
// budget). Kept pure and dependency-light for unit testing; the component wires
// it to the live store + the inline "adjusted" notice.

import type { IVisibilityConfig } from "@/store/model";

export interface IVisibilityBound {
  min: number;
  max: number;
  integer: boolean;
}

// The numeric fields of IVisibilityConfig (globalThreshold is a boolean).
export type TVisibilityNumericKey = Exclude<
  keyof IVisibilityConfig,
  "globalThreshold"
>;

// Hard ceilings are "slow-but-survivable, never OOM/freeze" caps, a little
// above the shipped defaults; floors are a sane few-hundred-to-1000 so the view
// is never starved. coverageTarget/viewportRefreshFraction keep the fractional
// ranges the UI already enforced.
export const VISIBILITY_BOUNDS: Record<
  TVisibilityNumericKey,
  IVisibilityBound
> = {
  stubThreshold: { min: 1000, max: 200000, integer: true },
  maxVisible: { min: 1000, max: 200000, integer: true },
  maxHydrated: { min: 500, max: 200000, integer: true },
  hydrationCacheCap: { min: 500, max: 200000, integer: true },
  coverageTarget: { min: 0.01, max: 1, integer: false },
  viewportRefreshFraction: { min: 0.01, max: 2, integer: false },
};

const NUMERIC_KEYS = Object.keys(VISIBILITY_BOUNDS) as TVisibilityNumericKey[];

function clampField(value: number, bound: IVisibilityBound): number {
  const clamped = Math.min(bound.max, Math.max(bound.min, value));
  return bound.integer ? Math.round(clamped) : clamped;
}

/**
 * Merge a proposed (partial) change onto the current config and return a fully
 * legal config plus the list of fields whose final value differs from what was
 * requested — so the UI can both reflect the accepted value and note what it
 * had to adjust.
 *
 * Non-finite entries (a cleared field → NaN) revert to the current value and
 * are not reported as adjusted.
 */
export function clampVisibilityConfig(
  proposed: Partial<IVisibilityConfig>,
  current: IVisibilityConfig,
): { config: IVisibilityConfig; adjusted: TVisibilityNumericKey[] } {
  // What the user effectively asked for: current, overlaid with finite proposals.
  const requested: Record<TVisibilityNumericKey, number> = {} as Record<
    TVisibilityNumericKey,
    number
  >;
  for (const key of NUMERIC_KEYS) {
    const proposedValue = proposed[key];
    requested[key] =
      typeof proposedValue === "number" && Number.isFinite(proposedValue)
        ? proposedValue
        : current[key];
  }

  // Per-field absolute clamp.
  const next: Record<TVisibilityNumericKey, number> = {} as Record<
    TVisibilityNumericKey,
    number
  >;
  for (const key of NUMERIC_KEYS) {
    next[key] = clampField(requested[key], VISIBILITY_BOUNDS[key]);
  }

  // Cross-field invariants.
  next.maxHydrated = Math.min(next.maxHydrated, next.maxVisible);
  next.hydrationCacheCap = Math.max(next.hydrationCacheCap, next.maxHydrated);

  const adjusted = NUMERIC_KEYS.filter((key) => next[key] !== requested[key]);

  return {
    config: {
      ...next,
      globalThreshold: proposed.globalThreshold ?? current.globalThreshold,
    },
    adjusted,
  };
}

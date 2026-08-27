import { describe, it, expect } from "vitest";
import {
  VISIBILITY_BOUNDS,
  clampVisibilityConfig,
} from "@/utils/visibilityConfigBounds";
import type { IVisibilityConfig } from "@/store/model";

// Mirrors the store default (src/store/annotation.ts).
const current: IVisibilityConfig = {
  stubThreshold: 10000,
  maxVisible: 50000,
  minimumVisible: 5000,
  maxHydrated: 20000,
  hydrationCacheCap: 40000,
  globalThreshold: true,
  coverageTarget: 0.17,
  revealMoreOnZoom: true,
  viewportRefreshFraction: 0.2,
};

describe("clampVisibilityConfig", () => {
  it("leaves an in-range change untouched and reports nothing adjusted", () => {
    const { config, adjusted } = clampVisibilityConfig(
      { maxVisible: 30000 },
      current,
    );
    expect(config.maxVisible).toBe(30000);
    expect(adjusted).toEqual([]);
  });

  it("clamps an over-ceiling value to the hard ceiling", () => {
    const { config, adjusted } = clampVisibilityConfig(
      { maxVisible: 9999999 },
      current,
    );
    expect(config.maxVisible).toBe(200000);
    expect(adjusted).toEqual(["maxVisible"]);
  });

  it("clamps a sub-floor value up and drags dependent fields with it", () => {
    // maxVisible 300 → floor 1000; maxHydrated (20000) can't exceed maxVisible.
    const { config, adjusted } = clampVisibilityConfig(
      { maxVisible: 300 },
      current,
    );
    expect(config.maxVisible).toBe(1000);
    expect(config.maxHydrated).toBe(1000);
    expect(adjusted).toContain("maxVisible");
    expect(adjusted).toContain("maxHydrated");
  });

  it("caps maxHydrated to maxVisible, dragging the cache up to keep cache >= maxHydrated", () => {
    const { config, adjusted } = clampVisibilityConfig(
      { maxHydrated: 60000 },
      current,
    );
    expect(config.maxHydrated).toBe(current.maxVisible); // 50000
    // cache (40000) must rise to the new maxHydrated (50000).
    expect(config.hydrationCacheCap).toBe(50000);
    expect(adjusted).toContain("maxHydrated");
    expect(adjusted).toContain("hydrationCacheCap");
  });

  it("caps minimumVisible at maxVisible (cross-field)", () => {
    // A minimum floor above the render cap is nonsensical — clamp it down.
    const { config, adjusted } = clampVisibilityConfig(
      { minimumVisible: 90000 },
      current,
    );
    expect(config.minimumVisible).toBe(current.maxVisible); // 50000
    expect(adjusted).toContain("minimumVisible");
  });

  it("drags minimumVisible down when maxVisible is lowered below it", () => {
    // Lowering the cap below the current floor pulls the floor down with it.
    const { config } = clampVisibilityConfig({ maxVisible: 3000 }, current);
    expect(config.maxVisible).toBe(3000);
    expect(config.minimumVisible).toBe(3000);
  });

  it("allows minimumVisible of 0 (defer to the zoom rule)", () => {
    const { config, adjusted } = clampVisibilityConfig(
      { minimumVisible: 0 },
      current,
    );
    expect(config.minimumVisible).toBe(0);
    expect(adjusted).toEqual([]);
  });

  it("raises hydrationCacheCap to at least maxHydrated (cross-field)", () => {
    const { config, adjusted } = clampVisibilityConfig(
      { hydrationCacheCap: 1000 },
      current,
    );
    expect(config.hydrationCacheCap).toBe(current.maxHydrated); // 20000
    expect(adjusted).toEqual(["hydrationCacheCap"]);
  });

  it("rounds integer fields", () => {
    const { config, adjusted } = clampVisibilityConfig(
      { maxVisible: 50000.7 },
      current,
    );
    expect(config.maxVisible).toBe(50001);
    expect(adjusted).toEqual(["maxVisible"]);
  });

  it("clamps the fractional fields to their ranges", () => {
    expect(
      clampVisibilityConfig({ coverageTarget: 5 }, current).config
        .coverageTarget,
    ).toBe(1);
    expect(
      clampVisibilityConfig({ coverageTarget: -1 }, current).config
        .coverageTarget,
    ).toBe(0.01);
    expect(
      clampVisibilityConfig({ viewportRefreshFraction: 9 }, current).config
        .viewportRefreshFraction,
    ).toBe(2);
  });

  it("reverts a NaN / empty entry to the current value without flagging it", () => {
    const { config, adjusted } = clampVisibilityConfig(
      { maxVisible: NaN },
      current,
    );
    expect(config.maxVisible).toBe(current.maxVisible);
    expect(adjusted).toEqual([]);
  });

  it("preserves the boolean globalThreshold", () => {
    const { config } = clampVisibilityConfig(
      { globalThreshold: false },
      current,
    );
    expect(config.globalThreshold).toBe(false);
  });

  it("preserves the boolean revealMoreOnZoom (and defaults to current)", () => {
    expect(
      clampVisibilityConfig({ revealMoreOnZoom: false }, current).config
        .revealMoreOnZoom,
    ).toBe(false);
    // Untouched → keeps the current value, and isn't reported as adjusted.
    const { config, adjusted } = clampVisibilityConfig(
      { maxVisible: 30000 },
      current,
    );
    expect(config.revealMoreOnZoom).toBe(true);
    expect(adjusted).not.toContain("revealMoreOnZoom");
  });

  it("exposes the agreed bounds", () => {
    expect(VISIBILITY_BOUNDS.maxVisible).toMatchObject({
      min: 1000,
      max: 200000,
    });
    expect(VISIBILITY_BOUNDS.maxHydrated.min).toBe(500);
    expect(VISIBILITY_BOUNDS.coverageTarget).toMatchObject({
      min: 0.01,
      max: 1,
    });
  });
});

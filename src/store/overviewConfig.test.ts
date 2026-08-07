import { describe, expect, it, vi } from "vitest";

vi.mock("@/utils/fetch", () => ({
  fetchAllPages: vi.fn(),
}));

vi.mock("@/store/progress", () => ({
  default: {},
}));

import {
  DEFAULT_ANNOTATION_OVERVIEW_CONFIG,
  resolveAnnotationOverviewConfig,
} from "./model";
import { setBaseCollectionValues } from "./GirderAPI";

describe("annotation overview configuration", () => {
  it("merges persisted partial settings over independent defaults", () => {
    const resolved = resolveAnnotationOverviewConfig({
      enabled: true,
      opacity: 0.4,
    });

    expect(resolved).toEqual({
      ...DEFAULT_ANNOTATION_OVERVIEW_CONFIG,
      enabled: true,
      opacity: 0.4,
    });
    expect(resolved).not.toBe(DEFAULT_ANNOTATION_OVERVIEW_CONFIG);
  });

  it("hydrates older and partial configuration metadata", () => {
    const older = setBaseCollectionValues({
      _id: "configuration-1",
      name: "Configuration",
      description: "",
      meta: {},
    } as any);
    const partial = setBaseCollectionValues({
      _id: "configuration-2",
      name: "Configuration",
      description: "",
      meta: { overviewConfig: { mode: "discs" } },
    } as any);

    expect(older.overviewConfig).toEqual(DEFAULT_ANNOTATION_OVERVIEW_CONFIG);
    expect(partial.overviewConfig).toEqual({
      ...DEFAULT_ANNOTATION_OVERVIEW_CONFIG,
      mode: "discs",
    });
  });
});

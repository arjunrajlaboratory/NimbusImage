import { describe, it, expect, beforeEach, vi } from "vitest";

import main from "./index";

// Regression test for issue #1239 / Codex review on PR #1262:
// saveContrastInView must NOT silently succeed when the personal dataset view
// cannot be persisted. Only callers opting into throwOnError (the AI panel)
// see the rejection; interactive UI callers keep the silent local-override
// behavior.

const contrast = {
  mode: "percentile",
  blackPoint: 5,
  whitePoint: 95,
} as any;

describe("saveContrastInView throwOnError", () => {
  beforeEach(() => {
    // Make updateDatasetView observable/benign for the editable path.
    (main as any).api.updateDatasetView = vi.fn(async () => ({}));
  });

  it("throws when there is no dataset view", async () => {
    main.setDatasetViewImpl(null);
    await expect(
      main.saveContrastInView({ layerId: "l1", contrast, throwOnError: true }),
    ).rejects.toThrow(/no dataset view/);
  });

  it("throws when the dataset view is not editable", async () => {
    // _accessLevel 0 => canEditDatasetView is false regardless of login.
    main.setDatasetViewImpl({ layerContrasts: {}, _accessLevel: 0 } as any);
    await expect(
      main.saveContrastInView({ layerId: "l1", contrast, throwOnError: true }),
    ).rejects.toThrow(/permission to edit/);
    // The local override is still applied (it just can't be persisted).
    expect(main.datasetView?.layerContrasts.l1).toEqual(contrast);
  });

  it("does not throw for non-AI callers even when not editable", async () => {
    main.setDatasetViewImpl({ layerContrasts: {}, _accessLevel: 0 } as any);
    // No throwOnError: interactive UI behavior is unchanged (silent).
    await expect(
      main.saveContrastInView({ layerId: "l1", contrast }),
    ).resolves.toBeUndefined();
    expect(main.datasetView?.layerContrasts.l1).toEqual(contrast);
  });
});

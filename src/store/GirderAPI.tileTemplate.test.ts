import { describe, expect, it, vi } from "vitest";

vi.mock("@/store/progress", () => ({ default: {} }));

import GirderAPI from "./GirderAPI";

describe("GirderAPI tileTemplateUrl", () => {
  it("adds an explicit share-link token without changing tile placeholders", () => {
    const api = new GirderAPI({
      apiRoot: "http://localhost:8080/api/v1",
    } as any);
    const template = api.tileTemplateUrl(
      { item: "item1", frameIndex: 3 } as any,
      "#ffffff",
      { mode: "absolute", blackPoint: 0, whitePoint: 255 },
      { min: 0, max: 255 } as any,
      null,
      null,
      "share-token",
    );

    expect(template).toContain("/tiles/zxy/{z}/{x}/{y}?");
    expect(
      new URL(template!.replace("{z}/{x}/{y}", "0/0/0")).searchParams.get(
        "token",
      ),
    ).toBe("share-token");
  });
});

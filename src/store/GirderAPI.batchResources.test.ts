import { describe, expect, expectTypeOf, it, vi } from "vitest";

vi.mock("@/utils/fetch", () => ({
  fetchAllPages: vi.fn(),
}));

vi.mock("@/store/progress", () => ({
  default: {},
}));

import GirderAPI from "./GirderAPI";
import type { IGirderFolder, IGirderProjectedResource } from "@/girder";

describe("GirderAPI.batchResources", () => {
  it("propagates an unauthorized response instead of returning empty data", async () => {
    const unauthorized = Object.assign(new Error("Unauthorized"), {
      isAxiosError: true,
      response: { status: 401 },
    });
    const client = {
      post: vi.fn().mockRejectedValue(unauthorized),
    } as any;

    await expect(
      new GirderAPI(client).batchResources({ folder: ["folder-1"] }),
    ).rejects.toBe(unauthorized);
  });

  it("types a field projection as a partial document", async () => {
    const client = {
      post: vi.fn().mockResolvedValue({
        data: { folder: { "folder-1": { _id: "folder-1", name: "One" } } },
      }),
    } as any;

    const result = await new GirderAPI(client).batchResources({
      folder: ["folder-1"],
      fields: ["name"],
    });

    expectTypeOf(result.folder).toEqualTypeOf<
      Record<string, IGirderProjectedResource<IGirderFolder>> | undefined
    >();
    expect(result.folder?.["folder-1"].name).toBe("One");
  });
});

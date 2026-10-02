import { describe, expect, it, vi } from "vitest";
import type { RestClientInstance } from "@/girder";

vi.mock("@/utils/fetch", () => ({
  fetchAllPages: vi.fn(),
}));

vi.mock("@/store/progress", () => ({
  default: {},
}));

import GirderAPI from "./GirderAPI";
import type { IDataset } from "./model";

describe("deleteDataset", () => {
  it("deletes through DELETE /resource, not DELETE /folder/:id", async () => {
    // DELETE /folder/:id needs a Girder "local"-queue worker (503 without one).
    const del = vi.fn().mockResolvedValue({ data: {} });
    const api = new GirderAPI({ delete: del } as unknown as RestClientInstance);
    const dataset = { id: "dataset-1" } as IDataset;

    await expect(api.deleteDataset(dataset)).resolves.toBe(dataset);

    expect(del).toHaveBeenCalledTimes(1);
    expect(del).toHaveBeenCalledWith("resource", {
      params: { resources: JSON.stringify({ folder: ["dataset-1"] }) },
    });
  });

  it("propagates a failed delete", async () => {
    const del = vi.fn().mockRejectedValue(new Error("boom"));
    const api = new GirderAPI({ delete: del } as unknown as RestClientInstance);

    await expect(api.deleteDataset({ id: "d" } as IDataset)).rejects.toThrow(
      "boom",
    );
  });
});

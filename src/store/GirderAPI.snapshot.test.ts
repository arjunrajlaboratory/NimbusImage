import { describe, expect, it, vi } from "vitest";
vi.mock("@/store/progress", () => ({ default: {} }));
import GirderAPI from "./GirderAPI";
import type { RestClientInstance } from "@/girder";

describe("snapshot image downloads", () => {
  it("fetches binary bytes with the authenticated client and propagates failures", async () => {
    const bytes = new Uint8Array([73, 73, 42, 0]).buffer;
    const get = vi
      .fn()
      .mockResolvedValueOnce({ data: bytes })
      .mockRejectedValueOnce(new Error("offline"));
    const api = new GirderAPI({ get } as unknown as RestClientInstance);
    const url = new URL(
      "http://localhost/api/v1/item/image/tiles/region?frame=3",
    );
    expect(await api.getSnapshotImage(url)).toBe(bytes);
    expect(get).toHaveBeenCalledWith(url.href, { responseType: "arraybuffer" });
    await expect(api.getSnapshotImage(url)).rejects.toThrow("offline");
  });
  it("rejects an empty server response instead of archiving a zero-byte image", async () => {
    const get = vi.fn().mockResolvedValue({ data: new ArrayBuffer(0) });
    const api = new GirderAPI({ get } as unknown as RestClientInstance);
    await expect(
      api.getSnapshotImage(new URL("http://localhost/region")),
    ).rejects.toThrow("no image data");
  });
});

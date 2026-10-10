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

describe("raw region reads", () => {
  it("reads unscaled samples from raw_region, not the 8-bit tiles/region TIFF", async () => {
    // 2x1 uint16 TIFF, one strip: samples 300 and 4095
    const buffer = new ArrayBuffer(8 + 2 + 6 * 12 + 4 + 4);
    const view = new DataView(buffer);
    view.setUint16(0, 0x4949);
    view.setUint16(2, 42, true);
    view.setUint32(4, 8, true);
    view.setUint16(8, 6, true);
    const entries: [number, number, number][] = [
      [256, 3, 2], // ImageWidth
      [257, 3, 1], // ImageLength
      [258, 3, 16], // BitsPerSample
      [259, 3, 1], // Compression: none
      [273, 4, 86], // StripOffsets
      [279, 4, 4], // StripByteCounts
    ];
    entries.forEach(([tag, type, value], i) => {
      const offset = 10 + i * 12;
      view.setUint16(offset, tag, true);
      view.setUint16(offset + 2, type, true);
      view.setUint32(offset + 4, 1, true);
      if (type === 3) view.setUint16(offset + 8, value, true);
      else view.setUint32(offset + 8, value, true);
    });
    view.setUint16(86, 300, true);
    view.setUint16(88, 4095, true);
    const get = vi.fn().mockResolvedValue({ data: buffer });
    const api = new GirderAPI({ get } as unknown as RestClientInstance);
    const region = await api.getRawRegion(
      "item1",
      3,
      { left: 0, top: 0, right: 2, bottom: 1 },
      100,
    );
    expect(get).toHaveBeenCalledWith("item/item1/raw_region", {
      params: { left: 0, top: 0, right: 2, bottom: 1, frame: 3 },
      responseType: "arraybuffer",
    });
    expect(Array.from(region!.image.data)).toEqual([300, 4095]);
  });
});

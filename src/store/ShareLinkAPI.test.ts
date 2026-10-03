import { describe, it, expect, vi } from "vitest";
import ShareLinkAPI, { shareLinkUrl } from "./ShareLinkAPI";

describe("ShareLinkAPI", () => {
  it("uses the documented routes", async () => {
    const client = {
      get: vi.fn(async () => ({ data: [] })),
      post: vi.fn(async () => ({ data: { token: "t" } })),
      delete: vi.fn(async () => ({ data: { revoked: true } })),
    } as any;
    const api = new ShareLinkAPI(client);
    expect(await api.create("v1", 30, "reviewers")).toEqual({ token: "t" });
    expect(client.post).toHaveBeenCalledWith("share_link", {
      datasetViewId: "v1",
      days: 30,
      label: "reviewers",
    });
    await api.list("ds1");
    expect(client.get).toHaveBeenCalledWith("share_link", {
      params: { datasetId: "ds1" },
    });
    await api.me();
    expect(client.get).toHaveBeenCalledWith("share_link/me");
    await api.revoke("l1");
    expect(client.delete).toHaveBeenCalledWith("share_link/l1");
  });

  it("builds the shared and embed URLs on the current page", () => {
    expect(shareLinkUrl("abc")).toBe(
      `${window.location.origin}${window.location.pathname}#/shared/abc`,
    );
    expect(shareLinkUrl("abc", true)).toContain("#/embed/abc");
  });
});

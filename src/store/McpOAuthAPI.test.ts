import { describe, it, expect, vi } from "vitest";
import McpOAuthAPI from "./McpOAuthAPI";

describe("McpOAuthAPI", () => {
  it("uses the plugin's consent routes and returns the next URL", async () => {
    const client = {
      get: vi.fn(async () => ({ data: { clientName: "Claude" } })),
      post: vi.fn(async (url: string) => ({
        data: { redirect: `https://claude.ai/cb?from=${url}` },
      })),
    } as any;
    const api = new McpOAuthAPI(client);
    expect(await api.getRequest("r/1")).toEqual({ clientName: "Claude" });
    expect(client.get).toHaveBeenCalledWith("mcp_oauth/request/r%2F1");
    expect(await api.approve("r1")).toBe(
      "https://claude.ai/cb?from=mcp_oauth/request/r1/approve",
    );
    await api.deny("r1");
    expect(client.post).toHaveBeenLastCalledWith("mcp_oauth/request/r1/deny");
  });

  it("lists and deletes the user's connected clients", async () => {
    const client = {
      get: vi.fn(async () => ({ data: [{ id: "g1" }] })),
      delete: vi.fn(async () => ({ data: {} })),
    } as any;
    const api = new McpOAuthAPI(client);
    expect(await api.listGrants()).toEqual([{ id: "g1" }]);
    expect(client.get).toHaveBeenCalledWith("mcp_oauth/grant");
    await api.deleteGrant("g/1");
    expect(client.delete).toHaveBeenCalledWith("mcp_oauth/grant/g%2F1");
  });
});

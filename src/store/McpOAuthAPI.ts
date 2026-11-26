import { RestClientInstance } from "@/girder";

/** What the consent page shows about a pending sign-in request. */
export interface IMcpOAuthRequest {
  clientName: string;
  clientId: string;
  redirectHost: string;
  // The client gets the code on this computer (e.g. Claude Code).
  localRedirect: boolean;
  resource: string;
  scope: string;
}

/** A client the user has connected (a grant), as the profile lists it. */
export interface IMcpOAuthGrant {
  id: string;
  clientName: string;
  clientId: string;
  redirectHost: string;
  created: string;
  lastUsed: string;
}

/** The user's side of the MCP OAuth flow (nimbus_mcp_oauth plugin, see
 * NIMBUSIMAGE_MCP_SERVER.md §6.3): consent, and the connected clients.
 * Approve and deny return the URL the browser goes to next: the client's
 * callback with a code or an error. */
export default class McpOAuthAPI {
  private readonly client: RestClientInstance;

  constructor(client: RestClientInstance) {
    this.client = client;
  }

  async getRequest(requestId: string): Promise<IMcpOAuthRequest> {
    const response = await this.client.get(
      `mcp_oauth/request/${encodeURIComponent(requestId)}`,
    );
    return response.data as IMcpOAuthRequest;
  }

  async approve(requestId: string): Promise<string> {
    const response = await this.client.post(
      `mcp_oauth/request/${encodeURIComponent(requestId)}/approve`,
    );
    return response.data.redirect as string;
  }

  async deny(requestId: string): Promise<string> {
    const response = await this.client.post(
      `mcp_oauth/request/${encodeURIComponent(requestId)}/deny`,
    );
    return response.data.redirect as string;
  }

  /** The user's connected clients. Rejects with a 404 while the plugin is
   * switched off. */
  async listGrants(): Promise<IMcpOAuthGrant[]> {
    const response = await this.client.get("mcp_oauth/grant");
    return response.data as IMcpOAuthGrant[];
  }

  /** Disconnects a client: its tokens stop working at once. */
  async deleteGrant(grantId: string): Promise<void> {
    await this.client.delete(`mcp_oauth/grant/${encodeURIComponent(grantId)}`);
  }
}

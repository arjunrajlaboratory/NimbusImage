import { RestClientInstance } from "@/girder";
import { IShareLink } from "./model";

/** Share-view links (SHARING.md "Share links"): capability URLs for one
 * dataset view, backed by a hidden read-only Girder user per link. */
export default class ShareLinkAPI {
  private readonly client: RestClientInstance;

  constructor(client: RestClientInstance) {
    this.client = client;
  }

  /** Create a link; `token` is returned only here. `days` 0 = no expiry. */
  async create(
    datasetViewId: string,
    days: number,
    label: string,
  ): Promise<IShareLink & { token: string }> {
    const response = await this.client.post("share_link", {
      datasetViewId,
      days,
      label,
    });
    return response.data as IShareLink & { token: string };
  }

  async list(datasetId: string): Promise<IShareLink[]> {
    const response = await this.client.get("share_link", {
      params: { datasetId },
    });
    return response.data as IShareLink[];
  }

  async revoke(linkId: string): Promise<IShareLink> {
    const response = await this.client.delete(`share_link/${linkId}`);
    return response.data as IShareLink;
  }

  /** The link the client's current token belongs to (404 for a login). */
  async me(): Promise<IShareLink> {
    const response = await this.client.get("share_link/me");
    return response.data as IShareLink;
  }
}

/** The URL a recipient opens; `embed` gives the chrome-less viewer. */
export function shareLinkUrl(token: string, embed = false): string {
  const base = `${window.location.origin}${window.location.pathname}`;
  return `${base}#/${embed ? "embed" : "shared"}/${token}`;
}

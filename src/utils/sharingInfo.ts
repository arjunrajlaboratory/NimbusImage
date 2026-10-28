import { isAxiosError } from "axios";
import { IDatasetAccessUser } from "@/store/model";
import { logError } from "@/utils/log";

interface SharingAccessList {
  public: boolean;
  users: IDatasetAccessUser[];
}

/**
 * Fetches sharing info from an API endpoint, returning null on failure.
 *
 * Handles the common pattern of loading an access list where:
 * - Success returns the full access list response
 * - Failure (e.g. insufficient permissions) returns null for graceful degradation
 *
 * Usage:
 * ```ts
 * const result = await fetchSharingInfo(
 *   () => store.api.getDatasetAccess(datasetId),
 * );
 * this.sharingIsPublic = result?.public ?? false;
 * this.sharingUsers = result?.users ?? null;
 * ```
 */
export async function fetchSharingInfo<T extends SharingAccessList>(
  apiFn: () => Promise<T>,
): Promise<T | null> {
  try {
    return await apiFn();
  } catch (error) {
    // Access lists need a full login: anonymous viewers of a public dataset
    // and share-link tokens get a 401, which is expected.
    if (!(isAxiosError(error) && error.response?.status === 401)) {
      logError("Failed to fetch sharing info:", error);
    }
    return null;
  }
}

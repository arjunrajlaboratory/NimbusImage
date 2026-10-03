import { ISnapshot } from "@/store/model";

/**
 * A snapshot's identity within a configuration: names are unique per dataset
 * view, not across the collection. Shared by the Snapshots palette and the
 * command palette's "Go to snapshot" commands.
 */
export function snapshotKey(snapshot: ISnapshot): string {
  return `${snapshot.datasetViewId}:${snapshot.name}`;
}

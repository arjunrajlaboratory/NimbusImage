import { shallowRef } from "vue";
import type { ISnapshot } from "@/store/model";
import type { TReturnType as TToolTypeSelectionValue } from "@/tools/creation/toolTypeCatalog";

// Escape hatches for commands whose effect lives inside a component that the
// palette can't reach: same shape as the main store's `paletteOpenRequests`.
// The owning component watches the request, performs it and clears it, so
// asking for the same thing twice in a row is still seen as a change. Kept
// out of `src/store/index.ts`, which is already 2000+ lines (and whose edits
// break HMR).

/** Open the tool-creation dialog pre-selected (honoured by Toolset.vue). */
export const toolCreationRequest = shallowRef<TToolTypeSelectionValue | null>(
  null,
);

/** Load a snapshot (honoured by Snapshots.vue). */
export const snapshotLoadRequest = shallowRef<ISnapshot | null>(null);

/**
 * Pre-select a property path (as `createPathStringFromPathArray` keys it) in
 * the Color-by-property dialog (honoured by ColorByPropertyDialog.vue).
 */
export const colorByPropertyRequest = shallowRef<string | null>(null);

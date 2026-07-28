import {
  getModule,
  Action,
  Module,
  Mutation,
  VuexModule,
} from "vuex-module-decorators";
import { markRaw } from "vue";
import store from "./root";

import main from "./index";
import annotation from "./annotation";
import filters from "./filters";

import { MAX_CONNECT_SELECTED, TIMELAPSE_CONNECTION_TAG } from "./constants";
import { IAnnotationConnection, TAnnotationOrStub } from "./model";
import {
  IConnectionRow,
  ITrackRow,
  buildConnectionRows,
  buildTrackRows,
  chainAnnotationsByTime,
  findConnectedComponents,
  findTimeTies,
} from "@/utils/connections";

export type TConnectionScope = "all" | "location" | "selected" | "filtered";
export type TConnectionGrouping = "flat" | "track";

export const CONNECTION_SCOPE_LABELS: Record<TConnectionScope, string> = {
  all: "All connections",
  location: "Current location",
  selected: "Selected objects",
  filtered: "Objects passing filters",
};

// View state for the Object Browser's Connections tab.
//
// Deliberately holds NO server data — connections themselves live in the
// annotation store, which owns their lifecycle (they are created alongside
// annotations and read directly by the timelapse draw path). If server data
// starts accumulating here, this split has failed and a full `connections`
// store extraction should be revisited instead.
@Module({ dynamic: true, store, name: "connectionList" })
export class ConnectionList extends VuexModule {
  scope: TConnectionScope = "all";
  grouping: TConnectionGrouping = "flat";

  selectedConnectionIds: Set<string> = markRaw(new Set());
  hoveredConnectionId: string | null = null;

  page: number = 1;
  itemsPerPage: number = 50;
  expandedTrackIds: Set<string> = markRaw(new Set());

  /**
   * Predicate deciding whether ONE connection is in scope.
   *
   * A predicate, not a set of qualifying annotation ids: building that set
   * meant scanning every annotation, and `annotationsForIteration`
   * materializes an array of all 709K stubs in stub-only mode — paid again on
   * every XY/Z/Time scrub while the tab is open. Connections are the far
   * smaller collection, so resolve their two endpoints instead.
   *
   * A connection qualifies when EITHER endpoint does — the same "touching"
   * rule the bulk delete dialog uses, and for the filtered scope it
   * deliberately surfaces links leaving the filtered set, which is where
   * mis-tracked objects hide.
   */
  get connectionInScope(): (connection: IAnnotationConnection) => boolean {
    switch (this.scope) {
      case "all":
        return () => true;
      case "selected": {
        const ids = annotation.selectedAnnotationIds;
        return ({ parentId, childId }) => ids.has(parentId) || ids.has(childId);
      }
      case "filtered": {
        // Reuse the filters module's own id map rather than rebuilding a set
        // from filteredAnnotations, which can be hundreds of thousands long.
        const ids = filters.filteredAnnotationIdToIdx;
        return ({ parentId, childId }) => ids.has(parentId) || ids.has(childId);
      }
      case "location": {
        const { xy, z, time } = main.currentLocation;
        const resolve = this.resolveAnnotation;
        const atLocation = (id: string): boolean => {
          const found = resolve(id);
          return (
            !!found &&
            found.location.XY === xy &&
            found.location.Z === z &&
            found.location.Time === time
          );
        };
        return ({ parentId, childId }) =>
          atLocation(parentId) || atLocation(childId);
      }
    }
  }

  get scopedConnections(): IAnnotationConnection[] {
    if (this.scope === "all") {
      return annotation.annotationConnections;
    }
    return annotation.annotationConnections.filter(this.connectionInScope);
  }

  get resolveAnnotation() {
    return (id: string): TAnnotationOrStub | undefined =>
      annotation.getAnnotationFromId(id) ?? annotation.getStub(id);
  }

  get connectionRows(): IConnectionRow[] {
    return buildConnectionRows(this.scopedConnections, this.resolveAnnotation);
  }

  get trackRows(): ITrackRow[] {
    if (this.grouping !== "track") {
      return [];
    }
    return buildTrackRows(this.connectionRows, this.resolveAnnotation);
  }

  /**
   * Number of tracks over ALL connections, ignoring scope and grouping.
   *
   * Deliberately not derived from `trackRows`, which is empty unless the
   * Connections tab is in track mode and is narrowed by the current scope. The
   * Timelapse panel wants the dataset-wide answer, the same way the browser's
   * tab badges do. As a getter it is cached against `annotationConnections`, so
   * it recomputes when connections change rather than on every render.
   */
  get trackCount(): number {
    return findConnectedComponents(annotation.annotationConnections).length;
  }

  get isConnectionSelected() {
    return (id: string): boolean => this.selectedConnectionIds.has(id);
  }

  /**
   * Selected ids that still correspond to a connection that exists.
   *
   * Other code deletes connections without going through this module —
   * `DeleteConnections.vue`'s bulk dialog and `deleteAllTimelapseConnections`
   * both call `annotationStore.deleteConnections` directly — so pruning only
   * inside `deleteConnectionsById` would leave ids here for links that are
   * gone, keeping the viewer's action panel open for a nonexistent connection
   * and allowing a second delete request for a stale id. Deriving existence
   * rather than reacting to every deletion path keeps this correct no matter
   * who does the deleting.
   */
  /**
   * Every connection id, in its own getter so that it is cached against the
   * CONNECTIONS rather than against the selection. Inlining this into
   * `selectedExistingConnectionIds` rebuilt a set of all ids on every selection
   * change, and that getter is read from `ImageViewer` and
   * `ConnectionActionPanel`, neither of which is gated by the Connections tab.
   */
  get connectionIdSet(): Set<string> {
    return new Set(annotation.annotationConnections.map(({ id }) => id));
  }

  get selectedExistingConnectionIds(): string[] {
    if (this.selectedConnectionIds.size === 0) {
      return [];
    }
    const existing = this.connectionIdSet;
    return [...this.selectedConnectionIds].filter((id) => existing.has(id));
  }

  /**
   * Selected connections that are ALSO in the current scope.
   *
   * Clearing the selection in `setScope` is not sufficient on its own: the
   * inputs a dynamic scope reads can change without `setScope` ever firing —
   * scrubbing XY/Z/Time under "current location", changing the object
   * selection under "selected objects", editing filters under "passing
   * filters". Each of those silently replaces the visible rows. So the list's
   * bulk delete is derived from this intersection rather than from the raw
   * selection, which makes "you can only bulk-delete rows the list is showing"
   * true by construction instead of dependent on catching every input change.
   *
   * The viewer's action panel deliberately uses the raw selection instead —
   * there, deleting the link you just clicked is the intent, in scope or not.
   */
  get selectedInScopeConnectionIds(): string[] {
    if (this.selectedConnectionIds.size === 0) {
      return [];
    }
    return this.scopedConnections
      .filter(({ id }) => this.selectedConnectionIds.has(id))
      .map(({ id }) => id);
  }

  get isTrackExpanded() {
    return (id: string): boolean => this.expandedTrackIds.has(id);
  }

  /** Selected annotations in selection order, resolved to annotations/stubs. */
  get selectedAnnotationsInOrder(): TAnnotationOrStub[] {
    const resolve = this.resolveAnnotation;
    const resolved: TAnnotationOrStub[] = [];
    for (const id of annotation.selectedAnnotationIds) {
      const found = resolve(id);
      if (found) {
        resolved.push(found);
      }
    }
    return resolved;
  }

  get canConnectSelected(): boolean {
    // Check the RAW id count first. Resolving the selection materializes an
    // annotation per id, and a server-mode select-all can be hundreds of
    // thousands — the cap exists to prevent that work, so it must not do the
    // work in order to apply itself.
    const selectedCount = annotation.selectedAnnotationIds.size;
    if (
      !main.isLoggedIn ||
      selectedCount < 2 ||
      selectedCount > MAX_CONNECT_SELECTED
    ) {
      return false;
    }
    return this.selectedAnnotationsInOrder.length >= 2;
  }

  /** True when the only thing blocking Connect selected is the size cap. */
  get connectSelectedExceedsMax(): boolean {
    return annotation.selectedAnnotationIds.size > MAX_CONNECT_SELECTED;
  }

  /**
   * Timepoints shared by two or more selected annotations. Non-empty means the
   * pending chain contains at least one pair whose direction cannot be inferred
   * from the data and will fall back to selection order.
   */
  get connectSelectedTimeTies(): number[] {
    // Nothing will be chained above the cap, so don't traverse a selection
    // that Connect selected has already refused.
    if (annotation.selectedAnnotationIds.size > MAX_CONNECT_SELECTED) {
      return [];
    }
    return findTimeTies(this.selectedAnnotationsInOrder);
  }

  @Mutation
  public setScope(scope: TConnectionScope) {
    this.scope = scope;
    this.page = 1;
    // Changing the scope changes what "the list" means, so a selection made
    // under the old scope must not survive to feed "Delete selected" — that
    // would delete connections the user can no longer see. Grouping is left
    // alone deliberately: it re-arranges the same set rather than redefining
    // it, so a selection stays meaningful across a flat/track toggle.
    this.selectedConnectionIds = markRaw(new Set());
  }

  @Mutation
  public setGrouping(grouping: TConnectionGrouping) {
    this.grouping = grouping;
    this.page = 1;
  }

  @Mutation
  public setPage(page: number) {
    this.page = page;
  }

  @Mutation
  public setItemsPerPage(itemsPerPage: number) {
    this.itemsPerPage = itemsPerPage;
  }

  /**
   * True when the last Connect selected produced no connections *because the
   * pairs already existed*, as opposed to because the request failed.
   */
  lastConnectSkippedAsDuplicate: boolean = false;

  @Mutation
  public setLastConnectSkippedAsDuplicate(value: boolean) {
    this.lastConnectSkippedAsDuplicate = value;
  }

  @Mutation
  public setHoveredConnectionId(id: string | null) {
    this.hoveredConnectionId = id;
  }

  @Mutation
  public setSelectedConnectionIds(ids: string[]) {
    this.selectedConnectionIds = markRaw(new Set(ids));
  }

  @Mutation
  public toggleConnectionSelection(id: string) {
    const next = new Set(this.selectedConnectionIds);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    this.selectedConnectionIds = markRaw(next);
  }

  @Mutation
  public toggleTrackExpanded(id: string) {
    const next = new Set(this.expandedTrackIds);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    this.expandedTrackIds = markRaw(next);
  }

  @Mutation
  protected resetConnectionListStateImpl() {
    this.selectedConnectionIds = markRaw(new Set());
    this.hoveredConnectionId = null;
    this.expandedTrackIds = markRaw(new Set());
    this.page = 1;
    // Per-dataset like the rest: a stale "was dedupe" flag would mislabel the
    // next empty result in a different dataset as "already connected".
    this.lastConnectSkippedAsDuplicate = false;
  }

  // Clear per-dataset connection view state. Scope and grouping survive: they
  // are view preferences (like filters), and a scope whose annotation set is
  // now empty simply shows an empty list, which is accurate rather than stale.
  @Action
  public resetConnectionListState() {
    this.resetConnectionListStateImpl();
  }

  @Action({ rawError: true })
  public async deleteConnectionsById(connectionIds: string[]) {
    if (connectionIds.length === 0) {
      return;
    }
    // Single batched request — never a delete-per-id loop.
    await annotation.deleteConnections(connectionIds);
    // Set membership, not Array.includes: this runs over the whole selection,
    // and a bulk delete of every selected row would otherwise be quadratic.
    const deleted = new Set(connectionIds);
    this.setSelectedConnectionIds(
      [...this.selectedConnectionIds].filter((id) => !deleted.has(id)),
    );
    // Hover is the other half of the same state. Pruning only the selection
    // left hoveredConnectionId pointing at a connection that no longer exists.
    if (this.hoveredConnectionId && deleted.has(this.hoveredConnectionId)) {
      this.setHoveredConnectionId(null);
    }
  }

  /**
   * Delete every selected connection, in scope or not. Used by the viewer's
   * action panel, where the selection is whatever line the user clicked.
   */
  @Action({ rawError: true })
  public async deleteSelectedConnections() {
    await this.deleteConnectionsById(this.selectedExistingConnectionIds);
  }

  /**
   * Delete only the selected connections the list is currently showing. Used
   * by the Connections tab so a stale selection can never remove rows that
   * scrolled out of scope — see `selectedInScopeConnectionIds`.
   */
  @Action({ rawError: true })
  public async deleteSelectedInScopeConnections() {
    await this.deleteConnectionsById(this.selectedInScopeConnectionIds);
  }

  /**
   * Chain the annotations selected in the Objects tab into connections,
   * ordered by ascending Time (parent = earlier). Ties fall back to selection
   * order; the UI surfaces that via `connectSelectedTimeTies`.
   */
  // rawError so a backend failure reaches the caller with its real message
  // instead of vuex-module-decorators' ERR_ACTION_ACCESS_UNDEFINED blob.
  @Action({ rawError: true })
  public async connectSelectedAnnotations(): Promise<IAnnotationConnection[]> {
    const datasetId = main.dataset?.id;
    if (!datasetId || !this.canConnectSelected) {
      return [];
    }
    const bases = chainAnnotationsByTime(this.selectedAnnotationsInOrder, {
      datasetId,
      label: "Connect selected",
      tags: [TIMELAPSE_CONNECTION_TAG],
      existingConnections: annotation.annotationConnections,
    });
    // Empty bases means every pair was already connected — that is the ONLY
    // way to conclude "nothing to do". The API layer swallows HTTP failures
    // and returns null, which becomes [], so an empty *result* cannot be
    // distinguished from dedupe and must not be reported as such.
    this.setLastConnectSkippedAsDuplicate(bases.length === 0);
    return await annotation.createConnectionsFromBases(bases);
  }
}

export default getModule(ConnectionList);

// Self-accept HMR to prevent vuex-module-decorators from re-registering
// the dynamic module (which causes duplicate getters and state overwrites).
if (import.meta.hot) {
  import.meta.hot.accept();
}

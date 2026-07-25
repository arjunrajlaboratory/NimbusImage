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
   * Ids of annotations that qualify under the current scope. `null` means the
   * scope is unrestricted, so callers skip the per-connection membership test
   * entirely rather than building a set of every annotation id.
   */
  get scopeAnnotationIds(): Set<string> | null {
    switch (this.scope) {
      case "all":
        return null;
      case "selected":
        return annotation.selectedAnnotationIds;
      case "location": {
        const { xy, z, time } = main.currentLocation;
        const ids = new Set<string>();
        for (const { id, location } of annotation.annotationsForIteration) {
          if (
            location.XY === xy &&
            location.Z === z &&
            location.Time === time
          ) {
            ids.add(id);
          }
        }
        return ids;
      }
      case "filtered":
        return new Set(filters.filteredAnnotations.map(({ id }) => id));
    }
  }

  /**
   * Connections in the current scope. A connection qualifies when EITHER
   * endpoint does — the same "touching" rule the bulk delete dialog uses, and
   * for the filtered scope it deliberately surfaces links leaving the filtered
   * set, which is where mis-tracked objects hide.
   */
  get scopedConnections(): IAnnotationConnection[] {
    const scopeIds = this.scopeAnnotationIds;
    if (scopeIds === null) {
      return annotation.annotationConnections;
    }
    return annotation.annotationConnections.filter(
      ({ parentId, childId }) =>
        scopeIds.has(parentId) || scopeIds.has(childId),
    );
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
  get selectedExistingConnectionIds(): string[] {
    if (this.selectedConnectionIds.size === 0) {
      return [];
    }
    const existing = new Set(
      annotation.annotationConnections.map(({ id }) => id),
    );
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
    const count = this.selectedAnnotationsInOrder.length;
    return main.isLoggedIn && count >= 2 && count <= MAX_CONNECT_SELECTED;
  }

  /** True when the only thing blocking Connect selected is the size cap. */
  get connectSelectedExceedsMax(): boolean {
    return this.selectedAnnotationsInOrder.length > MAX_CONNECT_SELECTED;
  }

  /**
   * Timepoints shared by two or more selected annotations. Non-empty means the
   * pending chain contains at least one pair whose direction cannot be inferred
   * from the data and will fall back to selection order.
   */
  get connectSelectedTimeTies(): number[] {
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
    return await annotation.createConnectionsFromBases(bases);
  }
}

export default getModule(ConnectionList);

// Self-accept HMR to prevent vuex-module-decorators from re-registering
// the dynamic module (which causes duplicate getters and state overwrites).
if (import.meta.hot) {
  import.meta.hot.accept();
}

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
  ITrackAnalysis,
  ITrackMetrics,
  ITrackRow,
  analyzeTracks,
  buildConnectionRows,
  buildTrackRows,
  chainAnnotationsByTime,
  computeTrackMetrics,
  findTimeTies,
} from "@/utils/connections";

export type TConnectionScope = "all" | "location" | "selected" | "filtered";
export type TConnectionGrouping = "flat" | "track";

export interface ITrackMetricRange {
  min: number | null;
  max: number | null;
}

/** Optional bounds on the dataset-wide track metrics (null = unbounded). */
export interface ITrackFilters {
  connectionCount: ITrackMetricRange;
  memberCount: ITrackMetricRange;
  duration: ITrackMetricRange;
}

export function createEmptyTrackFilters(): ITrackFilters {
  return {
    connectionCount: { min: null, max: null },
    memberCount: { min: null, max: null },
    duration: { min: null, max: null },
  };
}

function rangeActive({ min, max }: ITrackMetricRange): boolean {
  return min !== null || max !== null;
}

function inRange(value: number, { min, max }: ITrackMetricRange): boolean {
  return (min === null || value >= min) && (max === null || value <= max);
}

/**
 * The one field the track-filter predicate needs to resolve a connection's
 * dataset-wide track (any endpoint maps to the same track; parentId is the
 * one every caller has). The viewer's retention path only has a feature's
 * options, not the connection document, so the predicate must not demand
 * more than it uses.
 */
export type TConnectionTrackSource = Pick<IAnnotationConnection, "parentId">;

// Stable identities so the no-filter cases add zero cost and zero reactive
// dependencies to every draw pass that reads the predicates.
const PASSES_EVERY_CONNECTION = () => true;
const PASSES_EVERY_ANNOTATION: (annotationId: string) => boolean = () => true;

/**
 * One track's metrics against the active bounds — shared by the connection
 * predicate (list + both viewer draw paths) and the object opt-in predicate,
 * so the two can never disagree about which tracks pass.
 */
function trackMetricsPassFilters(
  metrics: ITrackMetrics,
  filters: ITrackFilters,
): boolean {
  if (
    !inRange(metrics.connectionCount, filters.connectionCount) ||
    !inRange(metrics.memberCount, filters.memberCount)
  ) {
    return false;
  }
  // An unknown duration (every member points at a deleted annotation) is pure
  // data rot, and "Clean up dangling" exists as the real remedy — so a
  // duration bound excludes such ghost tracks rather than keeping rows it
  // cannot be proven to match. The count bounds above are always known and
  // apply either way.
  if (rangeActive(filters.duration)) {
    return (
      metrics.duration !== null && inRange(metrics.duration, filters.duration)
    );
  }
  return true;
}

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
   * Property path labelling tracks in the "By track" view ([] = default
   * short-id labels). Lets the panel show the same track ids a property
   * worker computed (e.g. Parent-Child Connection IDs' `trackId`), so a track
   * flagged during post-processing can be found here by that id.
   *
   * Persisted per configuration alongside the annotation browser's displayed
   * columns — the path names a property id, which only means something within
   * one configuration.
   */
  trackLabelPath: string[] = [];

  /**
   * Bounds on the dataset-wide track metrics; connections whose track falls
   * outside them are hidden from the list AND from both viewer draw paths.
   * Session-only and reset per dataset — numeric ranges are meaningless
   * across datasets with different track scales, unlike scope/grouping.
   */
  trackFilters: ITrackFilters = createEmptyTrackFilters();

  get trackFiltersActive(): boolean {
    return (
      rangeActive(this.trackFilters.connectionCount) ||
      rangeActive(this.trackFilters.memberCount) ||
      rangeActive(this.trackFilters.duration)
    );
  }

  /**
   * Metrics per dataset-wide track. Only read while a track filter is active
   * — it resolves every connected annotation, so the inactive path must never
   * touch it. Cached against the connection graph and the annotation maps the
   * resolver reads: the resolver's closures read those (markRaw'd, always
   * REPLACED — rawStateMaps.test.ts) maps at invocation time, inside this
   * getter's own effect, so a map replacement invalidates this getter even
   * though the maps are reached through function-returning getters. Verified
   * live (PR #1340 Codex round 2 flagged the opposite): editing a member's
   * Time via setAnnotations changed the cached identity and the duration
   * (20 → 519), and deleting an annotation grew danglingConnectionIds.
   */
  get trackMetrics(): Map<string, ITrackMetrics> {
    return computeTrackMetrics(
      this.trackAnalysis.components,
      this.resolveAnnotation,
    );
  }

  /**
   * Predicate deciding whether ONE connection passes the track filters.
   *
   * Shared by the list (via `scopedConnections`) and the viewer's two draw
   * paths, so what the list shows and what the canvas draws cannot drift.
   * Keyed off the DATASET-WIDE track (via `trackKeyByAnnotationId`), so a
   * scope- or display-narrowed fragment is judged by its full track's
   * metrics, the same rule track colouring and duplicate-ID detection follow.
   *
   * With no filter active this is a stable always-true constant: the viewer
   * reads it on every draw pass, and the inactive case must cost nothing and
   * register no dependency on the metrics (which resolve every connected
   * annotation).
   */
  get connectionPassesTrackFilters(): (
    connection: TConnectionTrackSource,
  ) => boolean {
    if (!this.trackFiltersActive) {
      return PASSES_EVERY_CONNECTION;
    }
    const filters = this.trackFilters;
    const metricsByTrack = this.trackMetrics;
    const trackKeyByAnnotationId = this.trackAnalysis.trackKeyByAnnotationId;
    return ({ parentId }) => {
      const trackKey = trackKeyByAnnotationId.get(parentId);
      const metrics =
        trackKey === undefined ? undefined : metricsByTrack.get(trackKey);
      if (!metrics) {
        // Every connection's endpoints are in the analysis, so this is
        // unreachable in practice; fail open rather than hide data.
        return true;
      }
      return trackMetricsPassFilters(metrics, filters);
    };
  }

  /**
   * Session-only opt-in: when a track filter is narrowing, also hide the
   * OBJECTS of the filtered-out tracks from the image viewer. Off by default
   * — filtering the connections list must not silently make cells vanish
   * from the canvas. Unconnected objects are never hidden (they have no
   * track, so a track filter says nothing about them), and this is a display
   * lens only: the Objects tab, exports and analysis are untouched.
   */
  hideFilteredTrackObjects: boolean = false;

  /** True when the opt-in is actually narrowing (checkbox AND a live bound). */
  get trackFilterHidesObjects(): boolean {
    return this.trackFiltersActive && this.hideFilteredTrackObjects;
  }

  /**
   * Predicate deciding whether ONE annotation survives the object opt-in.
   * The viewer's displayed-set computed reads this on every rebuild, so while
   * the opt-in is off it is the same stable always-true constant contract as
   * `connectionPassesTrackFilters`.
   */
  get annotationPassesTrackFilters(): (annotationId: string) => boolean {
    if (!this.trackFilterHidesObjects) {
      return PASSES_EVERY_ANNOTATION;
    }
    const filters = this.trackFilters;
    const metricsByTrack = this.trackMetrics;
    const trackKeyByAnnotationId = this.trackAnalysis.trackKeyByAnnotationId;
    return (annotationId) => {
      const trackKey = trackKeyByAnnotationId.get(annotationId);
      if (trackKey === undefined) {
        // Unconnected: no track, so the filter says nothing about it.
        return true;
      }
      const metrics = metricsByTrack.get(trackKey);
      return !metrics || trackMetricsPassFilters(metrics, filters);
    };
  }

  /**
   * How many annotations survive the ordinary filters AND the object lens —
   * the number the render-coverage HUD prints as "(N passing filters)".
   * Reading `filteredAnnotations.length` there instead would claim every
   * annotation passes while the lens is hiding whole tracks (PR #1340 Codex
   * P2). While the lens is off this is a plain length read; the counting
   * pass is paid only while the opt-in narrows, cached against both inputs.
   */
  get displayedPassingCount(): number {
    const passing = filters.filteredAnnotations;
    if (!this.trackFilterHidesObjects) {
      return passing.length;
    }
    const passesTrackFilters = this.annotationPassesTrackFilters;
    let count = 0;
    for (const { id } of passing) {
      if (passesTrackFilters(id)) {
        count++;
      }
    }
    return count;
  }

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

  /** The scope's connections BEFORE track filters — the "M" in "N of M". */
  get scopeOnlyConnections(): IAnnotationConnection[] {
    if (this.scope === "all") {
      return annotation.annotationConnections;
    }
    return annotation.annotationConnections.filter(this.connectionInScope);
  }

  get scopedConnections(): IAnnotationConnection[] {
    if (!this.trackFiltersActive) {
      return this.scopeOnlyConnections;
    }
    return this.scopeOnlyConnections.filter(this.connectionPassesTrackFilters);
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
    return buildTrackRows(
      this.connectionRows,
      this.resolveAnnotation,
      this.trackAnalysis.trackKeyByAnnotationId,
    );
  }

  /**
   * One cached analysis of the complete connection graph.
   *
   * This getter depends only on the immutable `annotationConnections` array,
   * so scope/location/filter changes reuse the same result. Connection CRUD
   * replaces that array and invalidates the analysis, naturally handling track
   * merges and splits without persistent track state.
   */
  get trackAnalysis(): ITrackAnalysis {
    return analyzeTracks(annotation.annotationConnections);
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
    return this.trackAnalysis.components.length;
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
  public setHideFilteredTrackObjects(hide: boolean) {
    this.hideFilteredTrackObjects = hide;
  }

  // Replaces the object (never mutates in place) so watchers on
  // `trackFilters` fire by identity — the viewer redraws off exactly that.
  @Mutation
  public setTrackFilters(trackFilters: ITrackFilters) {
    this.trackFilters = trackFilters;
    this.page = 1;
    // Same rationale as setScope: an explicit filter change redefines what
    // "the list" means, so a selection made under the old definition must not
    // survive to feed "Delete selected". The in-scope intersection is the
    // structural guard; this is the belt to its braces.
    this.selectedConnectionIds = markRaw(new Set());
  }

  @Mutation
  protected setTrackLabelPathImpl(path: string[]) {
    this.trackLabelPath = path;
  }

  @Action
  public setTrackLabelPath(path: string[]) {
    this.setTrackLabelPathImpl(path);
    main.scheduleAnnotationBrowserSave();
  }

  // Restore the persisted path from the configuration. Uses the raw mutation
  // so hydration never schedules a save of its own.
  @Action
  public hydrateTrackLabelPath(path: string[]) {
    this.setTrackLabelPathImpl(path);
  }

  /**
   * Drop the path when its property leaves the configuration. The persisted
   * resolver (resolveAnnotationBrowserConfig) already does this at hydration,
   * but a live deletion must do the same immediately — same contract as
   * reconcileAnalysisPlotsForPropertyIds — or the panel keeps labelling from
   * the deleted property and a later browser save persists the orphaned path.
   * Called by properties.setProperties after the propertyIds write succeeds.
   */
  @Action
  public reconcileTrackLabelPathForPropertyIds(propertyIds: string[]) {
    if (
      this.trackLabelPath.length === 0 ||
      propertyIds.includes(this.trackLabelPath[0])
    ) {
      return;
    }
    // Through the scheduling setter: the cleared path must persist, exactly
    // like the plot reconciliation's configuration save.
    this.setTrackLabelPath([]);
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
    // References a property id from the outgoing configuration.
    // hydrateAnnotationBrowserState re-seeds it after this reset (same
    // lifecycle as displayedPropertyPaths in the properties store).
    this.trackLabelPath = [];
    // Numeric ranges are dataset-scale-specific, unlike scope/grouping.
    this.trackFilters = createEmptyTrackFilters();
    // Hiding objects is scoped to the filters it modifies.
    this.hideFilteredTrackObjects = false;
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
   * Connections with at least one endpoint pointing at an annotation that no
   * longer exists (deleted after the connection was made — data rot, common
   * in older datasets). Stubs count as resolvable, so in lazy mode an
   * unhydrated live annotation is never mistaken for a deleted one.
   *
   * O(connections) with two resolves each, and invalidated by hydration
   * changes — read it only from an active Connections tab (same gating rule
   * as the row getters) or from the cleanup action itself.
   */
  get danglingConnectionIds(): string[] {
    const resolve = this.resolveAnnotation;
    return annotation.annotationConnections
      .filter(
        ({ parentId, childId }) => !resolve(parentId) || !resolve(childId),
      )
      .map(({ id }) => id);
  }

  /**
   * Delete every dangling connection in the dataset — the whole dataset, not
   * the current scope: this is cleanup of rot, not a view operation. Callers
   * own the confirmation dialog. Recordable via the underlying batched
   * delete, so it participates in undo.
   */
  @Action({ rawError: true })
  public async deleteDanglingConnections() {
    await this.deleteConnectionsById(this.danglingConnectionIds);
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

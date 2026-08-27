import {
  IAnnotationConnection,
  IAnnotationConnectionBase,
  IAnnotationLocation,
  TAnnotationOrStub,
  isHydratedAnnotation,
} from "@/store/model";

// Custom class to ensure type safety for the parent map
class ParentMap {
  private map = new Map<string, string>();

  set(key: string, value: string) {
    this.map.set(key, value);
  }

  get(key: string): string {
    const value = this.map.get(key);
    if (value === undefined) {
      throw new Error(`Key not found in ParentMap: ${key}`);
    }
    return value;
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  forEach(callback: (value: string, key: string) => void) {
    this.map.forEach(callback);
  }
}

export interface IConnectedComponent {
  annotations: Set<string>;
  connections: IAnnotationConnection[];
}

export interface ITrackAnalysis {
  components: IConnectedComponent[];
  /**
   * Dataset-wide connected-component identity for each connected annotation.
   * Derived from `annotationConnections`; it is not lifecycle-managed state.
   */
  trackKeyByAnnotationId: ReadonlyMap<string, string>;
}

/**
 * Group connections into connected components ("tracks") via union-find.
 *
 * Moved verbatim out of AnnotationViewer.vue so the connection list and the
 * timelapse draw path share one implementation. Behavior must not change —
 * timelapse track colors and start/end markers are derived from these
 * components.
 */
export function findConnectedComponents(
  connections: IAnnotationConnection[],
): IConnectedComponent[] {
  const parent = new ParentMap();

  function find(x: string): string {
    if (!parent.has(x)) {
      parent.set(x, x);
      return x;
    }
    const currentParent = parent.get(x);
    if (currentParent === x) {
      return x;
    }
    const root = find(currentParent);
    if (root !== currentParent) {
      parent.set(x, root);
    }
    return root;
  }

  function union(x: string, y: string): void {
    parent.set(find(x), find(y));
  }

  connections.forEach((conn) => {
    union(conn.parentId, conn.childId);
  });

  const components = new Map<string, IConnectedComponent>();

  parent.forEach((_, node) => {
    const root = find(node);
    if (!components.has(root)) {
      components.set(root, {
        annotations: new Set(),
        connections: [],
      });
    }
    components.get(root)!.annotations.add(node);
  });

  connections.forEach((conn) => {
    const root = find(conn.parentId);
    components.get(root)!.connections.push(conn);
  });

  return Array.from(components.values());
}

// --- Track identity and color ---

/**
 * Stable key for a connected component: its lexicographically smallest member
 * id.
 *
 * The viewer and the connection list build their components from different
 * connection sets (the viewer filters to the displayed time window, the list to
 * the current scope), so they cannot share a component object. They CAN share a
 * key derivation — which is what makes a track the same colour in both places.
 * Picking "first element of the Set" instead would depend on insertion order,
 * and the two build their sets in different orders.
 */
export function trackKey(annotationIds: Iterable<string>): string {
  let smallest: string | null = null;
  for (const id of annotationIds) {
    if (smallest === null || id < smallest) {
      smallest = id;
    }
  }
  return smallest ?? "";
}

/**
 * Resolve a possibly-scoped component through a dataset-wide track index.
 *
 * Every member of one full component maps to the same key, so any member of a
 * displayed/scoped fragment is sufficient. The local key is retained as a
 * fallback for callers without a global index.
 */
export function trackKeyFromIndex(
  annotationIds: Iterable<string>,
  trackKeyByAnnotationId?: ReadonlyMap<string, string>,
): string {
  let smallest: string | null = null;
  let indexedKey: string | undefined;
  for (const annotationId of annotationIds) {
    if (indexedKey === undefined) {
      indexedKey = trackKeyByAnnotationId?.get(annotationId);
    }
    if (smallest === null || annotationId < smallest) {
      smallest = annotationId;
    }
  }
  return indexedKey ?? smallest ?? "";
}

/**
 * Analyze the complete connection graph once.
 *
 * Consumers reuse this result for the global track count and for translating
 * scoped/displayed fragments back to their dataset-wide color identity.
 */
export function analyzeTracks(
  connections: IAnnotationConnection[],
): ITrackAnalysis {
  const components = findConnectedComponents(connections);
  const trackKeyByAnnotationId = new Map<string, string>();
  for (const component of components) {
    const key = trackKey(component.annotations);
    for (const annotationId of component.annotations) {
      trackKeyByAnnotationId.set(annotationId, key);
    }
  }
  return { components, trackKeyByAnnotationId };
}

/** The colour every track is drawn in when per-track colouring is off. */
export const TRACK_UNIFORM_COLOR = "#FFFFFF";

function hslToHex(hue: number, saturation: number, lightness: number): string {
  const a = saturation * Math.min(lightness, 1 - lightness);
  const channel = (n: number) => {
    const k = (n + hue / 30) % 12;
    const value = lightness - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(value * 255)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${channel(0)}${channel(8)}${channel(4)}`;
}

/**
 * Multipliers that turn a track's hash into a hue. `seed` picks one, so a
 * shuffle changes the STEP rather than adding an offset.
 *
 * These are MEASURED values, not named constants, and that is the point. The
 * obvious choice is 1/φ, whose multiples are maximally spread — but that theory
 * is about `frac(i·φ)` for consecutive integers `i`, and our input is not `i`. It
 * is a polynomial hash whose delta between consecutive ObjectIds is 1 for most
 * steps and jumps at every hex carry ('9'→'a' is +40 in char codes). Under that
 * delta structure 1/φ hits a resonance and is the *worst* candidate tried, while
 * two multipliers a thousandth away from it score among the best. Naming a
 * constant here would imply the value was derived; it was searched for.
 *
 * Two properties are held simultaneously, because optimising either alone picks a
 * step that fails the other:
 *
 * 1. **Neighbouring ids must differ** — tracks created in one pass get
 *    consecutive ids, so this is the common case. Measured as the smallest hue
 *    gap between allocation-order neighbours, over 128 batches (4 id prefixes ×
 *    8 start offsets × 4 sizes up to 600).
 * 2. **Small nearby groups must all differ** — the five-id case from the
 *    original bug report, measured as the smallest gap over ALL pairs.
 *
 * | step      | worst neighbour gap | five-id all-pairs |
 * |-----------|---------------------|-------------------|
 * | 0.1912317 |               68.8° |             68.8° |
 * | 0.3594317 |               96.1° |             62.8° |
 * | 0.5954317 |               65.5° |             68.7° |
 * | 1/φ       |            **4.2°** |             67.9° |
 * | √2−1      |               44.4° |          **19.4°** |
 *
 * 1/φ measured 77.3° on the 40-id fixture this was first developed against,
 * because that fixture started at offset 0x0000 and never crossed the carry that
 * triggers the resonance — the figure quoted in the original docs was a fixture
 * artifact, not a property of the design. Each step here is also verified to
 * cover all 12 hue sectors and to produce a gap structure distinct from the other
 * two, which is what makes a shuffle a re-assignment rather than a rotation.
 */
const HUE_STEPS = [0.1912317, 0.3594317, 0.5954317] as const;

/**
 * Deterministic colour for a track, keyed by `trackKey`.
 *
 * Three properties matter, and each cost a bug to learn:
 *
 * 1. Saturation and lightness are FIXED, so only the hue varies. The original
 *    sliced the hash's own hex digits into `#rrggbb`, putting luminance under
 *    the hash's control — a third of tracks came out near-black or near-white
 *    and read as unhighlighted against the image.
 *
 * 2. Adjacent ids must not give adjacent hues. Track ids are ObjectIds
 *    allocated in one batch, so neighbouring tracks differ in the last
 *    character only. Invisible in synthetic fixtures; on a real dataset the
 *    first five tracks came out rgb(80,226,{162,218,215,213,211}) — five
 *    indistinguishable greens, because under `% 360` a one-character difference
 *    is a one-degree difference. Multiplying by an irrational step fixes it —
 *    see `HUE_STEPS` for which steps, and why the obvious choice (1/φ) is in
 *    fact the worst one available here.
 *
 * 3. A shuffle must re-ASSIGN, not rotate. The seed used to be folded into the
 *    hash accumulator, which for equal-length ids adds the same `31^n · seed` to
 *    every hash — a constant offset, so every hue moved by the same amount and
 *    every pairwise gap survived. Measured: an identical sorted gap multiset for
 *    every seed, with the closest pair pinned at 2.927° no matter how many times
 *    you shuffled. So the one thing the button exists for — separating a pair
 *    that happens to collide — was the one thing it could not do. The seed now
 *    selects the step, which genuinely re-assigns: ~97% of hues move and the
 *    closest pair changes both partners and distance.
 *
 * Deliberately does NOT use `hashString` from `@/utils/annotation`, even though
 * that one is stronger and its murmur finalizer is commented as existing "to
 * break sequential correlation in MongoDB ObjectIDs". The two are in direct
 * tension: the irrational step needs the sequential correlation the finalizer
 * destroys. Measured over 40 consecutive ObjectIds, smallest neighbouring-id hue
 * gap — hashString 9.2°, hashString with a plain `% 360` 3.0°. Swapping in the
 * "better" hash makes the output worse.
 */
export function trackColor(trackId: string, seed: number = 0): string {
  let hash = 0;
  for (let i = 0; i < trackId.length; i++) {
    hash = (trackId.charCodeAt(i) + ((hash << 5) - hash)) | 0;
  }
  // Non-negative modulo: `seed` is only ever incremented, but a caller passing a
  // negative would otherwise index past the end of the array and yield NaN.
  const step =
    HUE_STEPS[
      ((seed % HUE_STEPS.length) + HUE_STEPS.length) % HUE_STEPS.length
    ];
  return hslToHex(((Math.abs(hash) * step) % 1) * 360, 0.72, 0.6);
}

/** How many distinct palettes `shuffleTimelapseColors` cycles through. */
export const TRACK_PALETTE_COUNT = HUE_STEPS.length;

// --- Connection list rows ---

export interface IConnectionEndpoint {
  id: string;
  /** Display label: the annotation's name when set, else a short id. */
  label: string;
  /** Null when the endpoint annotation can't be resolved. */
  location: IAnnotationLocation | null;
  tags: string[];
  /** True when the endpoint annotation no longer exists (dangling link). */
  missing: boolean;
}

export interface IConnectionRow {
  connection: IAnnotationConnection;
  parent: IConnectionEndpoint;
  child: IConnectionEndpoint;
}

export interface ITrackRow {
  /** Smallest member annotation id — stable across re-renders. */
  id: string;
  /** Dataset-wide component key used only for color consistency. */
  colorKey: string;
  /** Member annotation ids, sorted. Drives "Select objects" on the header. */
  annotationIds: string[];
  annotationCount: number;
  /** Null when no member endpoint resolved, so no time range is knowable. */
  timeRange: { start: number; end: number } | null;
  rows: IConnectionRow[];
}

export type TResolveAnnotation = (id: string) => TAnnotationOrStub | undefined;

/** Last 6 characters of an ObjectId — enough to disambiguate visually. */
export function shortAnnotationId(id: string): string {
  return `#${id.slice(-6)}`;
}

function buildEndpoint(
  id: string,
  resolve: TResolveAnnotation,
): IConnectionEndpoint {
  const annotation = resolve(id);
  if (!annotation) {
    return {
      id,
      label: shortAnnotationId(id),
      location: null,
      tags: [],
      missing: true,
    };
  }
  // Only hydrated annotations carry a name; stubs have location + tags, which
  // is all a row needs, so unhydrated endpoints still render correctly.
  const name = isHydratedAnnotation(annotation) ? annotation.name : null;
  return {
    id,
    label: name || shortAnnotationId(id),
    location: annotation.location,
    tags: annotation.tags,
    missing: false,
  };
}

export function buildConnectionRows(
  connections: IAnnotationConnection[],
  resolve: TResolveAnnotation,
): IConnectionRow[] {
  return connections.map((connection) => ({
    connection,
    parent: buildEndpoint(connection.parentId, resolve),
    child: buildEndpoint(connection.childId, resolve),
  }));
}

/**
 * Group already-built rows into track rows. Components are computed over the
 * rows handed in (i.e. the current scope), so narrowing the scope can split a
 * track — the member count and time range on each track row make that visible.
 */
export function buildTrackRows(
  rows: IConnectionRow[],
  resolve: TResolveAnnotation,
  trackKeyByAnnotationId?: ReadonlyMap<string, string>,
): ITrackRow[] {
  const rowsByConnectionId = new Map(
    rows.map((row) => [row.connection.id, row]),
  );
  const components = findConnectedComponents(
    rows.map(({ connection }) => connection),
  );

  const trackRows = components.map((component): ITrackRow => {
    const memberIds = Array.from(component.annotations).sort();
    const times: number[] = [];
    for (const memberId of memberIds) {
      const annotation = resolve(memberId);
      if (annotation) {
        times.push(annotation.location.Time);
      }
    }
    return {
      // Keep the scoped component id for expansion/labels. Color identity is
      // deliberately separate because a scope can expose only a track tail.
      id: memberIds[0],
      colorKey: trackKeyFromIndex(memberIds, trackKeyByAnnotationId),
      annotationIds: memberIds,
      annotationCount: memberIds.length,
      timeRange: times.length
        ? { start: Math.min(...times), end: Math.max(...times) }
        : null,
      rows: component.connections
        .map(({ id }) => rowsByConnectionId.get(id))
        .filter((row): row is IConnectionRow => row !== undefined),
    };
  });

  // Earliest track first; tracks with no resolvable member sort last.
  return trackRows.sort((a, b) => {
    if (a.timeRange && b.timeRange) {
      return a.timeRange.start - b.timeRange.start || a.id.localeCompare(b.id);
    }
    if (a.timeRange) {
      return -1;
    }
    if (b.timeRange) {
      return 1;
    }
    return a.id.localeCompare(b.id);
  });
}

// --- Track labels from a property ---

/**
 * A track's label resolved from a per-annotation property value (e.g. the
 * `trackId` computed by the Parent-Child Connection IDs worker).
 *
 * The four statuses are deliberate: `partial` and `mixed` are staleness
 * signals, not error states. The worker assigned its values against the
 * connection graph as it existed at compute time, so members that disagree or
 * lack a value mean the graph changed since — exactly the tracks worth a
 * second look during post-processing.
 */
export type TTrackLabelResolution =
  | { status: "value"; value: number | string }
  /** One shared value, but some members have none (e.g. links added since). */
  | { status: "partial"; value: number | string }
  /** Members carry differing values (e.g. two tracks joined since). */
  | { status: "mixed"; values: (number | string)[] }
  /** No member has a value for the chosen property. */
  | { status: "missing" };

/**
 * Resolve a track's label from its members' property values.
 *
 * `getValue` returns the member's value for the chosen property path, or null
 * when it is confirmed to have none (not computed, or a dangling endpoint).
 * Callers must not pass members whose values are simply unknown — in lazy
 * mode the component skips a track until the fetch covers all its members,
 * so "missing" is never claimed about values that merely failed to load.
 */
export function resolveTrackLabelValue(
  annotationIds: Iterable<string>,
  getValue: (annotationId: string) => number | string | null,
): TTrackLabelResolution {
  const distinct: (number | string)[] = [];
  let missingCount = 0;
  for (const annotationId of annotationIds) {
    const value = getValue(annotationId);
    if (value === null) {
      missingCount++;
    } else if (!distinct.includes(value)) {
      distinct.push(value);
    }
  }
  if (distinct.length === 0) {
    return { status: "missing" };
  }
  if (distinct.length > 1) {
    return { status: "mixed", values: distinct };
  }
  return missingCount > 0
    ? { status: "partial", value: distinct[0] }
    : { status: "value", value: distinct[0] };
}

/**
 * Values carried by more than one resolved track label.
 *
 * Covers the graph change per-track resolution cannot see: deleting a
 * connection after the worker ran splits one component into two tracks whose
 * members each still unanimously carry the same old id — both resolve as a
 * clean `value`. Partial resolutions contribute their value too (a split half
 * that later gained an unvalued member still collides with its twin); mixed
 * and missing resolutions carry no single value to collide on.
 */
export function findDuplicateTrackLabelValues(
  resolutions: Iterable<TTrackLabelResolution>,
): Set<number | string> {
  const seen = new Set<number | string>();
  const duplicates = new Set<number | string>();
  for (const resolution of resolutions) {
    if (resolution.status !== "value" && resolution.status !== "partial") {
      continue;
    }
    if (seen.has(resolution.value)) {
      duplicates.add(resolution.value);
    } else {
      seen.add(resolution.value);
    }
  }
  return duplicates;
}

/**
 * Display form of a track-label value. Workers store integer ids as floats
 * (42.0), which JavaScript already reads back as 42; anything genuinely
 * fractional is kept short rather than shown at full float precision.
 */
export function formatTrackLabelValue(value: number | string): string {
  if (typeof value === "string") {
    return value;
  }
  return Number.isInteger(value) ? value.toString() : value.toPrecision(4);
}

// --- Connect selected ---

/** Key for an unordered annotation pair, for dedupe against existing links. */
function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * Time values that appear more than once among the given annotations.
 *
 * Same-frame pairs carry no directional information in the data, so
 * `chainAnnotationsByTime` falls back to selection order for them. The caller
 * surfaces this rather than hiding it — under drag-select, "selection order"
 * is effectively arbitrary.
 */
export function findTimeTies(annotations: TAnnotationOrStub[]): number[] {
  const counts = new Map<number, number>();
  for (const annotation of annotations) {
    const time = annotation.location.Time;
    counts.set(time, (counts.get(time) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .filter(([, count]) => count > 1)
    .map(([time]) => time)
    .sort((a, b) => a - b);
}

/**
 * Chain annotations into connections ordered by ascending Time.
 *
 * `parentId` is always the EARLIER annotation and `childId` the later one —
 * the later object is the child pointing back at its earlier parent, matching
 * `createTimelapseConnection`'s normalization. Inverting this would produce
 * links backwards relative to every existing connection.
 *
 * Ties (same Time) fall back to selection order: `annotationsInSelectionOrder`
 * is sorted with `Array.prototype.sort`, which is stable, so equal times keep
 * their incoming order without an explicit tiebreaker.
 */
export function chainAnnotationsByTime(
  annotationsInSelectionOrder: TAnnotationOrStub[],
  options: {
    datasetId: string;
    label: string;
    tags: string[];
    existingConnections: IAnnotationConnection[];
  },
): IAnnotationConnectionBase[] {
  const ordered = annotationsInSelectionOrder
    .slice()
    .sort((a, b) => a.location.Time - b.location.Time);

  const existingPairs = new Set(
    options.existingConnections.map(({ parentId, childId }) =>
      pairKey(parentId, childId),
    ),
  );

  const bases: IAnnotationConnectionBase[] = [];
  for (let i = 0; i < ordered.length - 1; i++) {
    const parent = ordered[i];
    const child = ordered[i + 1];
    // Skip pairs already linked in either direction rather than duplicating.
    if (existingPairs.has(pairKey(parent.id, child.id))) {
      continue;
    }
    existingPairs.add(pairKey(parent.id, child.id));
    bases.push({
      label: options.label,
      tags: options.tags,
      parentId: parent.id,
      childId: child.id,
      datasetId: options.datasetId,
    });
  }
  return bases;
}

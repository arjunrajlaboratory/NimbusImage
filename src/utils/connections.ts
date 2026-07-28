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

// Golden-ratio conjugate. Successive multiples of it are maximally spread on
// the unit interval, which is what turns "hashes one apart" into "hues 222°
// apart" below.
const GOLDEN_RATIO_CONJUGATE = 0.618033988749895;

/**
 * Deterministic colour for a track, keyed by `trackKey`.
 *
 * Two properties matter, and each cost a bug to learn:
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
 *    indistinguishable greens. Under `% 360` a one-character difference is a
 *    one-degree difference. The golden angle turns it into 222°.
 *
 * Deliberately does NOT use `hashString` from `@/utils/annotation`, even though
 * that one is stronger and its murmur finalizer is commented as existing "to
 * break sequential correlation in MongoDB ObjectIDs". The two are in direct
 * tension: the golden-angle step needs the sequential correlation that the
 * finalizer destroys. Measured over 40 consecutive ObjectIds, smallest hue gap
 * between neighbouring ids — this hash 77.3°, hashString 9.2°, hashString with
 * a plain `% 360` 3.0°. Swapping in the "better" hash makes the output worse.
 *
 * `seed` is folded into the accumulator rather than added to the hue, so
 * re-rolling re-permutes the assignment instead of rotating the whole wheel —
 * a rotation would leave any confusable pair exactly as confusable.
 */
export function trackColor(trackId: string, seed: number = 0): string {
  let hash = seed;
  for (let i = 0; i < trackId.length; i++) {
    hash = (trackId.charCodeAt(i) + ((hash << 5) - hash)) | 0;
  }
  const hue = ((Math.abs(hash) * GOLDEN_RATIO_CONJUGATE) % 1) * 360;
  return hslToHex(hue, 0.72, 0.6);
}

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
      // Sorted, so this is `trackKey(component.annotations)` — the same key the
      // viewer colours the track by.
      id: memberIds[0],
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

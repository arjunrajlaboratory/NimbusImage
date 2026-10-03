import {
  AnnotationShape,
  IAnnotation,
  IAnnotationStub,
  IGeoJSPosition,
} from "@/store/model";

type AnnotationUpdateField = keyof Omit<IAnnotation, "id">;

const annotationUpdateFields: AnnotationUpdateField[] = [
  "name",
  "tags",
  "shape",
  "channel",
  "location",
  "coordinates",
  "datasetId",
  "color",
];

export type AnnotationUpdatePatch = Partial<IAnnotation> & { id: string };

// Relies on annotation field producers serializing keys in a stable order
// (true for the schema-defined fields above). False negatives only cause us
// to send an unchanged field — never a correctness issue.
function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function getAnnotationUpdatePatch(
  before: Partial<IAnnotation>,
  after: Partial<IAnnotation>,
): AnnotationUpdatePatch | null {
  // Accepts partials so the stub-only-mode edit path can diff stub-shaped
  // objects (tags/color/etc., no coordinates/name) without a force-cast. An
  // entry with no id can't be patched.
  if (after.id === undefined) {
    return null;
  }
  const patch: AnnotationUpdatePatch = { id: after.id };

  for (const field of annotationUpdateFields) {
    const value = after[field];
    if (
      value === undefined ||
      before[field] === value ||
      jsonEqual(before[field], value)
    ) {
      continue;
    }
    patch[field] = value as never;
  }

  return Object.keys(patch).length > 1 ? patch : null;
}

// The stub-carried fields that can be patched locally after a stub-only-mode
// edit (see buildStubUpdates). `centroid` is only emitted for point stubs whose
// coordinate moved (a point's coordinate IS its centroid), so the local centroid
// index + spatial index can follow the move without a reload.
export interface IStubFieldUpdate {
  id: string;
  tags?: string[];
  color?: string | null;
  centroid?: IGeoJSPosition;
}

/**
 * Build backend update patches for stub-only mode, where `annotations[]` is
 * empty so the full-annotation update path produces no patches. The same
 * `editFunction` used for full annotations is applied to each stub (treated as
 * a partial annotation — stubs carry tags/color but not name/coordinates), and
 * the diff is taken against the stub.
 *
 * Returns both the patches to send to the backend and the subset of changes
 * (tags/color) to apply to local stubs so the canvas stays in sync. Fields the
 * stub does not track (e.g. name) are still persisted via `patches` but produce
 * no `stubFieldUpdates` entry.
 */
export function buildStubUpdates(
  ids: string[],
  getStub: (id: string) => IAnnotationStub | undefined,
  editFunction: (annotation: IAnnotation) => void,
): { patches: AnnotationUpdatePatch[]; stubFieldUpdates: IStubFieldUpdate[] } {
  const patches: AnnotationUpdatePatch[] = [];
  const stubFieldUpdates: IStubFieldUpdate[] = [];

  for (const id of ids) {
    const stub = getStub(id);
    if (!stub) {
      continue;
    }
    // A stub is a partial annotation: it carries tags/color/location/etc. but
    // not coordinates/name. getAnnotationUpdatePatch diffs over partials, so no
    // force-cast is needed there. The single `as IAnnotation` at the
    // editFunction boundary documents the precondition: in stub-only mode
    // editFunction must only touch stub-carried fields — touching
    // coordinates/name would read undefined.
    const before: Partial<IAnnotation> = { ...stub, tags: [...stub.tags] };
    const after: Partial<IAnnotation> = { ...stub, tags: [...stub.tags] };
    editFunction(after as IAnnotation);

    const patch = getAnnotationUpdatePatch(before, after);
    if (!patch) {
      continue;
    }
    patches.push(patch);

    const fieldUpdate: IStubFieldUpdate = { id };
    let hasStubField = false;
    if (patch.tags !== undefined) {
      fieldUpdate.tags = patch.tags;
      hasStubField = true;
    }
    if (patch.color !== undefined) {
      fieldUpdate.color = patch.color;
      hasStubField = true;
    }
    // A point's only coordinate IS its centroid, so a moved point must refresh
    // the local centroid (and downstream centroid/spatial indexes). Only points
    // qualify — for other shapes the centroid is not coordinates[0].
    if (
      patch.coordinates !== undefined &&
      patch.coordinates.length > 0 &&
      stub.shape === AnnotationShape.Point
    ) {
      fieldUpdate.centroid = patch.coordinates[0];
      hasStubField = true;
    }
    if (hasStubField) {
      stubFieldUpdates.push(fieldUpdate);
    }
  }

  return { patches, stubFieldUpdates };
}

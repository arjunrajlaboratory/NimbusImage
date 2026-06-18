import { IAnnotation, IAnnotationStub } from "@/store/model";

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
  before: IAnnotation,
  after: IAnnotation,
): AnnotationUpdatePatch | null {
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

// The tag/color fields that a stub carries and that can therefore be patched
// locally after a stub-only-mode edit (see buildStubUpdates).
export interface IStubFieldUpdate {
  id: string;
  tags?: string[];
  color?: string | null;
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
    const before = { ...stub, tags: [...stub.tags] } as unknown as IAnnotation;
    const after = { ...stub, tags: [...stub.tags] } as unknown as IAnnotation;
    editFunction(after);

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
    if (hasStubField) {
      stubFieldUpdates.push(fieldUpdate);
    }
  }

  return { patches, stubFieldUpdates };
}

import { IAnnotation } from "@/store/model";

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

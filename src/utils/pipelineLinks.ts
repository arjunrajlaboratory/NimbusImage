import { cloneDeep, isEqual, isPlainObject } from "lodash";

import {
  IAnnotationPipelineStep,
  IAnnotationProperty,
  IAnnotationSetup,
  IPropertyPipelineStep,
  IToolConfiguration,
  TPipelineStep,
} from "@/store/model";

// A step added from an existing tool (sourceToolId) or property
// (sourcePropertyId) is LINKED to it: the source's current values are what run.
// The step's own fields are a saved copy, used only when the source is gone.
// See "Linked steps" in WORKER_PIPELINES.md.

// Equality as persisted: configurations travel as JSON, which drops
// `undefined` keys, so `{ color: undefined }` and `{}` are the same saved
// value. Child editors re-emit with explicit `undefined` keys on mount
// (AnnotationConfiguration always emits `color`), so a plain isEqual would read
// an untouched step as edited.
// Walks the values directly rather than serializing them: the editor's dirty
// check runs this over the whole pipeline on every edit.
export function samePersistedValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    // JSON writes an undefined array element as null.
    return (
      a.length === b.length &&
      a.every((value, index) =>
        samePersistedValue(value ?? null, b[index] ?? null),
      )
    );
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const definedKeys = (value: Record<string, unknown>) =>
      Object.keys(value).filter((key) => value[key] !== undefined);
    const objectA = a as Record<string, unknown>;
    const objectB = b as Record<string, unknown>;
    const keysA = definedKeys(objectA);
    return (
      keysA.length === definedKeys(objectB).length &&
      keysA.every((key) => samePersistedValue(objectA[key], objectB[key]))
    );
  }
  return isEqual(a, b);
}

// The fields a linked annotation step takes from its tool.
type TToolLinkedFields = Pick<
  IAnnotationPipelineStep,
  "image" | "workerInterfaceValues" | "annotation" | "connectTo" | "jobDateTag"
>;

// The fields a linked property step takes from its property.
type TPropertyLinkedFields = Pick<
  IPropertyPipelineStep,
  "image" | "workerInterfaceValues" | "shape" | "inputTags"
>;

// A worker tool's values as annotation-step fields (the inverse of the
// pipeline runner's buildTransientTool), sharing the tool's objects. Null when
// the tool has no worker image. `annotation` falls back to
// `fallbackAnnotation` for a tool saved without one.
function toolFields(
  tool: IToolConfiguration,
  fallbackAnnotation: IAnnotationSetup,
): TToolLinkedFields | null {
  const image = tool.values?.image?.image;
  if (!image) {
    return null;
  }
  return {
    image,
    workerInterfaceValues: tool.values.workerInterfaceValues ?? {},
    annotation: tool.values.annotation ?? fallbackAnnotation,
    connectTo: tool.values.connectTo || undefined,
    jobDateTag: tool.values.jobDateTag ?? undefined,
  };
}

// A property's settings as property-step fields, sharing its objects.
function propertyFields(property: IAnnotationProperty): TPropertyLinkedFields {
  return {
    image: property.image,
    workerInterfaceValues: property.workerInterface ?? {},
    shape: property.shape,
    inputTags: property.tags,
  };
}

// Copies of a tool's or property's settings as step fields, for a new step.
export function toolLinkedFields(
  tool: IToolConfiguration,
  fallbackAnnotation: IAnnotationSetup,
): TToolLinkedFields | null {
  return cloneDeep(toolFields(tool, fallbackAnnotation));
}

export function propertyLinkedFields(
  property: IAnnotationProperty,
): TPropertyLinkedFields {
  return cloneDeep(propertyFields(property));
}

// The step's link fields, for comparing a step against its source.
function stepToolLinkedFields(
  step: IAnnotationPipelineStep,
): TToolLinkedFields {
  return {
    image: step.image,
    workerInterfaceValues: step.workerInterfaceValues,
    annotation: step.annotation,
    connectTo: step.connectTo,
    jobDateTag: step.jobDateTag,
  };
}

function stepPropertyLinkedFields(
  step: IPropertyPipelineStep,
): TPropertyLinkedFields {
  return {
    image: step.image,
    workerInterfaceValues: step.workerInterfaceValues,
    shape: step.shape,
    inputTags: step.inputTags,
  };
}

function findSourceTool(
  step: TPipelineStep,
  tools: IToolConfiguration[],
): IToolConfiguration | null {
  if (step.kind !== "annotation" || !step.sourceToolId) {
    return null;
  }
  const tool = tools.find((t) => t.id === step.sourceToolId);
  return tool?.values?.image?.image ? tool : null;
}

export function findSourceProperty(
  step: TPipelineStep,
  propertyList: IAnnotationProperty[],
): IAnnotationProperty | null {
  if (step.kind !== "property" || !step.sourcePropertyId) {
    return null;
  }
  return propertyList.find((p) => p.id === step.sourcePropertyId) ?? null;
}

// How a step relates to a source: not linked, linked to a live source (with
// its name), or linked to a source it can no longer use, in which case the
// runner uses the step's saved copy. An unusable source is either not in the
// loaded list (`notFound`: a deleted one, or a property not loaded yet, which
// the runner reloads before deciding) or a tool still there but without a
// worker image (`noWorker`).
export type TStepLinkState =
  | { state: "unlinked" }
  | { state: "linked"; sourceKind: "tool" | "property"; sourceName: string }
  | { state: "missing"; sourceKind: "tool" | "property"; reason: "notFound" }
  | {
      state: "missing";
      sourceKind: "tool";
      reason: "noWorker";
      sourceName: string;
    };

export function stepLinkState(
  step: TPipelineStep,
  tools: IToolConfiguration[],
  propertyList: IAnnotationProperty[],
): TStepLinkState {
  if (step.kind === "annotation") {
    if (!step.sourceToolId) {
      return { state: "unlinked" };
    }
    const tool = tools.find((t) => t.id === step.sourceToolId);
    if (!tool) {
      return { state: "missing", sourceKind: "tool", reason: "notFound" };
    }
    return findSourceTool(step, tools)
      ? { state: "linked", sourceKind: "tool", sourceName: tool.name }
      : {
          state: "missing",
          sourceKind: "tool",
          reason: "noWorker",
          sourceName: tool.name,
        };
  }
  if (!step.sourcePropertyId) {
    return { state: "unlinked" };
  }
  const property = findSourceProperty(step, propertyList);
  return property
    ? { state: "linked", sourceKind: "property", sourceName: property.name }
    : { state: "missing", sourceKind: "property", reason: "notFound" };
}

// The step with its saved copy replaced by (a copy of) its live source's
// values. Returns the step itself (same object) when it is unlinked, its
// source is gone, or the copy already matches, so callers can tell whether
// anything changed; the source is only cloned when it differs.
export function resolveLinkedStep<T extends TPipelineStep>(
  step: T,
  tools: IToolConfiguration[],
  propertyList: IAnnotationProperty[],
): T;
export function resolveLinkedStep(
  step: TPipelineStep,
  tools: IToolConfiguration[],
  propertyList: IAnnotationProperty[],
): TPipelineStep {
  if (step.kind === "annotation") {
    const tool = findSourceTool(step, tools);
    const fields = tool && toolFields(tool, step.annotation);
    if (!fields || samePersistedValue(fields, stepToolLinkedFields(step))) {
      return step;
    }
    return { ...step, ...cloneDeep(fields) };
  }
  const property = findSourceProperty(step, propertyList);
  if (!property) {
    return step;
  }
  const fields = propertyFields(property);
  return samePersistedValue(fields, stepPropertyLinkedFields(step))
    ? step
    : { ...step, ...cloneDeep(fields) };
}

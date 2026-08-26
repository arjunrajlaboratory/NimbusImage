// Everything that narrows the visible object set, in ONE place.
//
// Three surfaces report this: the app-bar Filters badge, the app-bar Analysis
// badge, and the render-coverage HUD ("Showing 826 of 826 in view (1 filter
// applied)"). They used to be counted independently, which is how a saved
// lasso gate could narrow 708,983 annotations to 72,925 while the HUD read
// like data loss — the badge was the only cue and it lives far from the count
// the user is actually reading. Counting here once means the three cannot
// drift.
//
// Pure data: a constraint records WHAT it is, not how to say it. Rendering a
// phrase needs the properties store (to name a property path), so it lives in
// `describeConstraint` / `summarizeActiveConstraints` below, which take a
// resolver — the collectors stay callable from the filters store without
// pulling a store dependency into a hot getter.

import {
  IAnalysisPlot,
  IAnnotationFilter,
  IIdAnnotationFilter,
  IPropertyAnnotationFilter,
  IROIAnnotationFilter,
  ITagAnnotationFilter,
  PropertyFilterMode,
  TAnalysisAxis,
} from "@/store/model";
import { CATEGORICAL_AXES } from "@/utils/analysisAxes";

// Which panel owns the constraint — the badge that counts it, and the panel
// the HUD opens when the user clicks the suffix.
export type TConstraintSource = "filters" | "analysis";

export type TConstraintKind =
  | "tag"
  | "currentFrame"
  | "selection"
  | "hiddenLayers"
  | "property"
  | "roi"
  | "annotationId"
  | "gate";

export interface IActiveConstraint {
  source: TConstraintSource;
  kind: TConstraintKind;
  // Property filters: the path being filtered, so the phrase can name it.
  propertyPath?: string[];
  // Gates: the plot's axes, so the phrase can name the plane it was drawn on.
  xAxis?: TAnalysisAxis | null;
  yAxis?: TAnalysisAxis | null;
}

export interface IActiveConstraintsInput {
  tagFilter: ITagAnnotationFilter;
  onlyCurrentFrame: boolean;
  selectionFilter: IIdAnnotationFilter;
  // The permissive default is `true`; only the non-default (objects on hidden
  // layers hidden) narrows anything.
  showAnnotationsFromHiddenLayers: boolean;
  propertyFilters: IPropertyAnnotationFilter[];
  roiFilters: IROIAnnotationFilter[];
  annotationIdFilters: IIdAnnotationFilter[];
  analysisPlots: IAnalysisPlot[];
  // Resolved gate ids by plot id. A gate that is enabled and drawn but not yet
  // resolved constrains nothing (see activeAnalysisGateIdLists), so it is not
  // counted — the same three-way predicate the gate consumers use.
  analysisGateIds: { [plotId: string]: string[] | undefined };
}

const isEnabled = (filter: IAnnotationFilter) => filter.enabled;

// An enabled values-mode filter with an empty values list is a deliberate
// pass-all: emptying the values textarea writes `values: []` meaning "do not
// filter" (PropertyFilterHistogram), the client filtering path passes
// everything for it (filters.ts), and the backend drops it
// (dropNoOpPropertyFilters). Counting it would announce narrowing that the
// viewer contradicts — the same reason an unresolved gate is not counted.
// Range mode always narrows: the client shape always carries numeric bounds.
const narrowsAnything = (filter: IPropertyAnnotationFilter) =>
  filter.valuesOrRange !== PropertyFilterMode.Values ||
  (filter.values?.length ?? 0) > 0;

// Every constraint currently narrowing the object set, Filters panel first
// then Analysis gates in plot order. `emptyROIFilter` (a region still being
// drawn) filters nothing yet and is deliberately absent.
export function collectActiveConstraints(
  input: IActiveConstraintsInput,
): IActiveConstraint[] {
  const constraints: IActiveConstraint[] = [];
  const pushFilter = (kind: TConstraintKind) =>
    constraints.push({ source: "filters", kind });

  if (input.tagFilter.enabled) {
    pushFilter("tag");
  }
  if (input.onlyCurrentFrame) {
    pushFilter("currentFrame");
  }
  if (input.selectionFilter.enabled) {
    pushFilter("selection");
  }
  if (!input.showAnnotationsFromHiddenLayers) {
    pushFilter("hiddenLayers");
  }
  for (const filter of input.propertyFilters
    .filter(isEnabled)
    .filter(narrowsAnything)) {
    constraints.push({
      source: "filters",
      kind: "property",
      propertyPath: filter.propertyPath,
    });
  }
  input.roiFilters.filter(isEnabled).forEach(() => pushFilter("roi"));
  input.annotationIdFilters
    .filter(isEnabled)
    .forEach(() => pushFilter("annotationId"));
  for (const plot of input.analysisPlots) {
    if (
      plot.gateEnabled &&
      plot.gate !== null &&
      input.analysisGateIds[plot.id] !== undefined
    ) {
      constraints.push({
        source: "analysis",
        kind: "gate",
        xAxis: plot.xAxis,
        yAxis: plot.yAxis,
      });
    }
  }
  return constraints;
}

// How many constraints are active, optionally restricted to one panel's own.
// Each badge counts what its own panel can show: a Filters badge that counted
// gates pointed at a filter the user could not find or clear.
export function countActiveConstraints(
  constraints: IActiveConstraint[],
  source?: TConstraintSource,
): number {
  return source === undefined
    ? constraints.length
    : constraints.filter((constraint) => constraint.source === source).length;
}

// A noun phrase per constraint, split so a group of identical constraints can
// be pluralized ("2 property filters on Area") without string surgery.
export interface IConstraintPhrase {
  noun: string;
  qualifier: string;
}

const KIND_NOUNS: Record<TConstraintKind, string> = {
  tag: "tag filter",
  currentFrame: "current-frame filter",
  selection: "selection filter",
  hiddenLayers: "hidden-layer filter",
  property: "property filter",
  roi: "region filter",
  annotationId: "object-list filter",
  gate: "lasso gate",
};

const CATEGORICAL_AXIS_TEXT = new Map(
  CATEGORICAL_AXES.map(({ key, text }) => [key, text]),
);

// Display name for one analysis axis. Property paths need the properties
// store, so the caller supplies the resolver (the HUD has it; the filters
// store deliberately does not reach for it in a getter).
export function describeAxis(
  axis: TAnalysisAxis | null | undefined,
  resolvePropertyName: (path: string[]) => string | null,
): string | null {
  if (!axis) {
    return null;
  }
  return axis.type === "categorical"
    ? CATEGORICAL_AXIS_TEXT.get(axis.key) ?? axis.key
    : resolvePropertyName(axis.path);
}

export function describeConstraint(
  constraint: IActiveConstraint,
  resolvePropertyName: (path: string[]) => string | null,
): IConstraintPhrase {
  const noun = KIND_NOUNS[constraint.kind];
  if (constraint.kind === "property") {
    const name = constraint.propertyPath
      ? resolvePropertyName(constraint.propertyPath)
      : null;
    return { noun, qualifier: name ? `on ${name}` : "" };
  }
  if (constraint.kind === "gate") {
    const x = describeAxis(constraint.xAxis, resolvePropertyName);
    const y = describeAxis(constraint.yAxis, resolvePropertyName);
    // Both axes or neither: "on Area" for a half-configured plot would read as
    // a one-dimensional gate, which is not a thing.
    return { noun, qualifier: x && y ? `on ${x} × ${y}` : "" };
  }
  return { noun, qualifier: "" };
}

// "1 lasso gate on Area × PECAM1; 2 property filters on Area" — the tooltip
// body for the HUD suffix. Identical phrases collapse into one counted entry,
// in the order the constraints were collected.
export function summarizeActiveConstraints(
  constraints: IActiveConstraint[],
  resolvePropertyName: (path: string[]) => string | null,
): string {
  const groups: { phrase: IConstraintPhrase; count: number }[] = [];
  for (const constraint of constraints) {
    const phrase = describeConstraint(constraint, resolvePropertyName);
    const existing = groups.find(
      (group) =>
        group.phrase.noun === phrase.noun &&
        group.phrase.qualifier === phrase.qualifier,
    );
    if (existing) {
      existing.count += 1;
    } else {
      groups.push({ phrase, count: 1 });
    }
  }
  return groups
    .map(({ phrase, count }) => {
      const noun = count === 1 ? phrase.noun : `${phrase.noun}s`;
      return `${count} ${noun}${phrase.qualifier ? ` ${phrase.qualifier}` : ""}`;
    })
    .join("; ");
}

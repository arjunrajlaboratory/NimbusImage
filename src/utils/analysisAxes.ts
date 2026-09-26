import { TAnalysisAxis, TAnalysisCategoricalKey } from "@/store/model";
import { createPathStringFromPathArray } from "@/utils/paths";

// v-select items for the analysis panel axis pickers. Encoded as strings so
// the select's model stays a primitive (object equality in v-select items is
// reference-based, which breaks across store-rebuilt axis objects).
export interface IAxisItem {
  text: string;
  value: string;
}

export const CATEGORICAL_AXES: {
  key: TAnalysisCategoricalKey;
  text: string;
}[] = [
  { key: "tags", text: "Tags" },
  { key: "shape", text: "Shape" },
  { key: "channel", text: "Channel" },
  { key: "xy", text: "XY position" },
  { key: "z", text: "Z slice" },
  { key: "time", text: "Time point" },
];

export const CATEGORICAL_AXIS_KEYS: readonly TAnalysisCategoricalKey[] =
  CATEGORICAL_AXES.map(({ key }) => key);

export function isCategoricalAxisKey(
  value: unknown,
): value is TAnalysisCategoricalKey {
  return (
    typeof value === "string" &&
    (CATEGORICAL_AXIS_KEYS as readonly string[]).includes(value)
  );
}

// '.' is safe as the separator: MongoDB forbids it in the subIds a property
// path is made of, which is why createPathStringFromPathArray uses it.
const AXIS_SEP = ".";
const PROPERTY_PREFIX = "prop";
const CATEGORICAL_PREFIX = "cat";

export function encodeAxis(axis: TAnalysisAxis | null): string | null {
  if (!axis) {
    return null;
  }
  return axis.type === "property"
    ? PROPERTY_PREFIX + AXIS_SEP + createPathStringFromPathArray(axis.path)
    : CATEGORICAL_PREFIX + AXIS_SEP + axis.key;
}

export function decodeAxis(encoded: string | null): TAnalysisAxis | null {
  if (!encoded) {
    return null;
  }
  const [prefix, ...rest] = encoded.split(AXIS_SEP);
  if (prefix === PROPERTY_PREFIX && rest.length > 0) {
    return { type: "property", path: rest };
  }
  // Validated rather than cast: an unrecognised key would fall through the
  // category identity builder and silently produce an axis with no values.
  if (prefix === CATEGORICAL_PREFIX && isCategoricalAxisKey(rest[0])) {
    return { type: "categorical", key: rest[0] };
  }
  return null;
}

/**
 * The two property paths of a dataset's UMAP embedding, if it has one: the
 * first property whose name mentions UMAP (case-insensitive) and that has
 * two numeric sub-values, preferring ones named x / y, then the two
 * lowest-numbered components (0 / 1 or 1 / 2, x first). Null when
 * nothing qualifies, which hides the UMAP buttons.
 *
 * `paths` are computed property paths ([propertyId, subId]);
 * `propertyName(path)` is the property's display name for the path.
 */
export function findUmapAxes(
  paths: string[][],
  propertyName: (path: string[]) => string,
): { xAxis: TAnalysisAxis; yAxis: TAnalysisAxis } | null {
  const groups = new Map<string, string[][]>();
  for (const path of paths) {
    if (path.length < 2 || !/umap/i.test(propertyName(path))) {
      continue;
    }
    const parent = createPathStringFromPathArray(path.slice(0, -1));
    groups.set(parent, [...(groups.get(parent) ?? []), path]);
  }
  const leafOf = (path: string[]) => path[path.length - 1].toLowerCase();
  const letterRank = (leaf: string) =>
    /(^|[^a-z])x$/.test(leaf) ? 0 : /(^|[^a-z])y$/.test(leaf) ? 1 : 2;
  // Components may be numbered from 0 (`0`/`1`, `UMAP_0`/`UMAP_1`) or from 1:
  // either way the lowest number is x and the next is y.
  const componentIndex = (leaf: string) => {
    const match = /(\d+)$/.exec(leaf);
    return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
  };
  const compare = (a: string[], b: string[]) => {
    const [leafA, leafB] = [leafOf(a), leafOf(b)];
    return (
      letterRank(leafA) - letterRank(leafB) ||
      componentIndex(leafA) - componentIndex(leafB)
    );
  };
  for (const members of groups.values()) {
    if (members.length < 2) {
      continue;
    }
    const [x, y] = [...members].sort(compare);
    return {
      xAxis: { type: "property", path: x },
      yAxis: { type: "property", path: y },
    };
  }
  return null;
}

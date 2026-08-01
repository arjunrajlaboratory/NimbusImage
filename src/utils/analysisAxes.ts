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
  // Validated rather than cast: an unrecognised key would fall through every
  // branch of categoricalLabel and silently produce an axis with no values.
  if (prefix === CATEGORICAL_PREFIX && isCategoricalAxisKey(rest[0])) {
    return { type: "categorical", key: rest[0] };
  }
  return null;
}

import { TUnitLength, TUnitTime, unitLengthOptions } from "@/store/model";

const oneUnitToMeterConversion = {
  nm: 1e-9,
  µm: 1e-6,
  mm: 1e-3,
  m: 1,
};

export function convertLength(
  value: number,
  oldUnit: TUnitLength,
  newUnit: TUnitLength,
) {
  const multiplier =
    oneUnitToMeterConversion[oldUnit] / oneUnitToMeterConversion[newUnit];
  return multiplier * value;
}

/**
 * Format a physical length as a human-readable string, picking the unit in
 * which the value reads best (the largest unit where it is at least 1).
 */
export function formatLength(value: number, unit: TUnitLength): string {
  // unitLengthOptions is ordered from smallest (nm) to largest (m)
  let bestUnit = unitLengthOptions[0];
  for (const candidate of unitLengthOptions) {
    if (convertLength(value, unit, candidate) >= 1) {
      bestUnit = candidate;
    }
  }
  const bestValue = convertLength(value, unit, bestUnit);
  const formatted =
    bestValue >= 100
      ? Math.round(bestValue).toString()
      : bestValue.toPrecision(3);
  return `${formatted} ${bestUnit}`;
}

const oneUnitToSecondConversion = {
  ms: 1e-3,
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
};

export function convertTime(
  value: number,
  oldUnit: TUnitTime,
  newUnit: TUnitTime,
) {
  const multiplier =
    oneUnitToSecondConversion[oldUnit] / oneUnitToSecondConversion[newUnit];
  return multiplier * value;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return bytes + " B";
  } else if (bytes < 1024 * 1024) {
    return (bytes / 1024).toFixed(2) + " KB";
  } else if (bytes < 1024 * 1024 * 1024) {
    return (bytes / (1024 * 1024)).toFixed(2) + " MB";
  } else {
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
  }
}

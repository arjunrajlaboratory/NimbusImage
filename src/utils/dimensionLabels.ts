import type { IDimensionLabels, TUnitLength } from "@/store/model";
import { convertLength } from "@/utils/conversion";
import { medianPositiveSpacing } from "@/utils/stats";

function normalizeLengthUnit(rawUnit: string): TUnitLength | null {
  const unit = rawUnit.trim().toLowerCase().replace("μ", "µ");
  if (unit === "nm" || unit === "nanometer" || unit === "nanometers") {
    return "nm";
  }
  if (
    unit === "µm" ||
    unit === "um" ||
    unit === "micron" ||
    unit === "microns" ||
    unit === "micrometer" ||
    unit === "micrometers"
  ) {
    return "µm";
  }
  if (unit === "mm" || unit === "millimeter" || unit === "millimeters") {
    return "mm";
  }
  if (unit === "m" || unit === "meter" || unit === "meters") {
    return "m";
  }
  return null;
}

export function parseLengthLabelUm(label: string): number | null {
  const match = label
    .trim()
    .match(/^([+-]?(?:\d+\.?\d*|\.\d+))\s*([a-zA-Zµμ]+)$/);
  if (!match) {
    return null;
  }
  const value = Number(match[1]);
  const unit = normalizeLengthUnit(match[2]);
  if (!Number.isFinite(value) || unit === null) {
    return null;
  }
  return convertLength(value, unit, "µm");
}

export function inferZStepFromDimensionLabelsUm(
  dimensionLabels?: IDimensionLabels | null,
): number | null {
  const labels = dimensionLabels?.z;
  if (!labels || labels.length < 2) {
    return null;
  }
  const positions = labels.map((label) => parseLengthLabelUm(label));
  if (positions.some((position) => position === null)) {
    return null;
  }
  return medianPositiveSpacing(positions as number[]);
}

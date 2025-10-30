// ---- Types for ND2 metadata extraction ----
export type Nd2ExperimentEntry =
  | { type: "TimeLoop"; count: number; parameters: { periodMs: number } }
  | {
      type: "XYPosLoop";
      count: number;
      parameters: { points: { stagePositionUm: [number, number, number] }[] };
    }
  | {
      type: "ZStackLoop";
      count: number;
      parameters: { stepUm: number; homeIndex?: number; bottomToTop?: boolean };
    };

export interface Nd2LikeMeta {
  nd2_experiment?: Nd2ExperimentEntry[];
}

// ---- Format helpers ----
export function formatDurationShort(ms: number): string {
  if (!isFinite(ms)) return "";
  if (ms < 1) return `${ms.toFixed(0)} ms`;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${trimFloat(s)} s`;
  const m = s / 60;
  if (m < 60) return `${trimFloat(m)} min`;
  const h = m / 60;
  if (h < 24) return `${trimFloat(h)} h`;
  const d = h / 24;
  return `${trimFloat(d)} d`;
}

export function formatDistanceShort(um: number): string {
  if (!isFinite(um)) return "";
  // Pick µm by default; switch to mm if large
  if (Math.abs(um) >= 1000) return `${trimFloat(um / 1000)} mm`;
  if (Math.abs(um) >= 1) return `${trimFloat(um)} µm`;
  // go to nm if very small
  return `${trimFloat(um * 1000)} nm`;
}

export function trimFloat(n: number): string {
  // Up to 3 sig-ish digits without trailing zeros
  const s =
    Math.abs(n) >= 100
      ? n.toFixed(0)
      : Math.abs(n) >= 10
        ? n.toFixed(1)
        : Math.abs(n) >= 1
          ? n.toFixed(2)
          : Math.abs(n) >= 0.1
            ? n.toFixed(3)
            : Math.abs(n) >= 0.01
              ? n.toFixed(4)
              : n.toFixed(5);
  return s.replace(/(?:\.0+|(\.\d*?[1-9])0+)$/, "$1");
}

// ---- Core extraction from ND2 metadata ----
export function getTimeLabels(meta: Nd2LikeMeta): string[] | null {
  const exps = meta.nd2_experiment ?? [];
  const time = exps.find((e) => e.type === "TimeLoop") as
    | Extract<Nd2ExperimentEntry, { type: "TimeLoop" }>
    | undefined;
  if (!time) return null;

  const count = Math.max(0, time.count | 0);
  const periodMs = Math.max(0, time.parameters.periodMs || 0);

  const labels: string[] = [];
  for (let i = 0; i < count; i++) {
    labels.push(formatDurationShort(i * periodMs));
  }
  return labels;
}

export function getZLabels(meta: Nd2LikeMeta): string[] | null {
  const exps = meta.nd2_experiment ?? [];
  const z = exps.find((e) => e.type === "ZStackLoop") as
    | Extract<Nd2ExperimentEntry, { type: "ZStackLoop" }>
    | undefined;
  if (!z) return null;

  const count = Math.max(0, z.count | 0);
  const stepUm = Number(z.parameters.stepUm ?? 0) || 0;

  // If homeIndex exists, center around it; else start at 0
  const hasHome = Number.isFinite(z.parameters.homeIndex);
  const home = hasHome ? (z.parameters.homeIndex as number) : 0;

  const valuesUm: number[] = [];
  for (let i = 0; i < count; i++) {
    const delta = hasHome ? (i - home) * stepUm : i * stepUm;
    valuesUm.push(delta);
  }

  return valuesUm.map((v) => formatDistanceShort(v));
}

export function getXYLabels(meta: Nd2LikeMeta): string[] | null {
  const exps = meta.nd2_experiment ?? [];
  const xy = exps.find((e) => e.type === "XYPosLoop") as
    | Extract<Nd2ExperimentEntry, { type: "XYPosLoop" }>
    | undefined;
  if (!xy) return null;

  const points = xy.parameters.points;
  if (!points || points.length === 0) return null;

  return points.map((point) => {
    const [x, y] = point.stagePositionUm;
    return `${trimFloat(x)}, ${trimFloat(y)}`;
  });
}

// ---- Helper function to extract dimension labels from ND2 metadata ----
// This function attempts to extract labels from ND2 metadata if available,
// otherwise falls back to the provided fallback extraction logic
export function extractDimensionLabelsFromND2(
  dim: "XY" | "Z" | "T" | "C",
  tilesInternalMetadata: { [key: string]: any }[] | null,
  assignmentSize: number,
): string[] | null {
  if (!tilesInternalMetadata) return null;

  // Check if we have ND2 metadata from any of the files
  for (const internalMeta of tilesInternalMetadata) {
    if (internalMeta && internalMeta.nd2_experiment) {
      let nd2Labels: string[] | null = null;

      switch (dim) {
        case "T":
          nd2Labels = getTimeLabels(internalMeta as Nd2LikeMeta);
          break;
        case "Z":
          nd2Labels = getZLabels(internalMeta as Nd2LikeMeta);
          break;
        case "XY":
          nd2Labels = getXYLabels(internalMeta as Nd2LikeMeta);
          break;
        case "C":
          // C dimension doesn't have ND2 extraction logic
          return null;
      }

      // If we found ND2 labels and they match the expected size, use them
      if (nd2Labels && nd2Labels.length === assignmentSize) {
        return nd2Labels;
      }
    }
  }

  return null;
}

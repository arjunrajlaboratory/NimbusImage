// Domain vocabulary for the command palette. Each row is a set of words that
// should find each other: typing any one also matches commands that use the
// others. Keep this short; worker `description` Docker labels are the main
// source of "semantic" matches, and improving those improves search for free.
// Words are written already normalized (lowercase, no diacritics).
const SYNONYM_GROUPS: readonly string[][] = [
  ["spot", "spots", "puncta", "punctum", "dots", "dot", "foci"],
  ["cell", "cells", "nuclei", "nucleus", "segment", "segmentation"],
  ["measure", "measurement", "property", "properties", "metric", "metrics"],
  ["object", "objects", "annotation", "annotations"],
  ["channel", "channels", "layer", "layers"],
  ["bookmark", "snapshot", "snapshots"],
  ["download", "export"],
  ["upload", "import"],
  ["plot", "plots", "graph", "chart", "analysis"],
];

const SYNONYMS = new Map<string, string[]>();
for (const group of SYNONYM_GROUPS) {
  for (const word of group) {
    SYNONYMS.set(
      word,
      group.filter((other) => other !== word),
    );
  }
}

/** Other words that should match `word` (already normalized), if any. */
export function synonymsOf(word: string): readonly string[] {
  return SYNONYMS.get(word) ?? [];
}

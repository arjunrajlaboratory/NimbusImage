// Domain vocabulary for the command palette. Each row is a set of words that
// should find each other: typing any one also matches commands that use the
// others. Keep this short; worker `description` Docker labels are the main
// source of "semantic" matches, and improving those improves search for free.
// Words are written already normalized (lowercase, no diacritics).
// Never group opposite state verbs (show/hide, open/close, on/off): a command
// whose title flips with state ("Hide minimap") would then match a query
// asking for the state it already has ("show minimap") and do the opposite.
// State-flipping commands carry the verb of what they will do instead.
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
  ["merge", "merged", "projection", "mip"],
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

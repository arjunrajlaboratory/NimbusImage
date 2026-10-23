// Words that name a state or a change of state, in opposite pairs. One list
// for both guards against a command doing the opposite of what was asked:
// - the scorer matches these only to a whole title word or keyword, never
//   a substring ("lock" in "Unlock", "roll" in "Unroll") or subsequence;
// - oppositeKeywords.test.ts fails if one array literal holds both words of
//   a pair (a state-flipping command advertising both directions).
// A state-flipping command's title, keywords and aliases name only what it
// will do; see COMMAND_PALETTE.md "A state verb never matches its opposite".
export const OPPOSITE_PAIRS: readonly (readonly [string, string])[] = [
  ["show", "hide"],
  ["open", "close"],
  ["add", "remove"],
  ["on", "off"],
  ["lock", "unlock"],
  ["freeze", "unfreeze"],
  ["roll", "unroll"],
  ["enable", "disable"],
  ["start", "stop"],
  ["dark", "light"],
  ["filtered", "unfiltered"],
  // "filter" asks for a filter: as a loose prefix it also found "Remove
  // filter: X" and "…filters" turn-off titles, which end one.
  ["filter", "unfilter"],
  ["merge", "unmerge"],
  ["2d", "3d"],
];

// Pair words that keep ordinary prefix matching in the scorer: each is also
// the start of real names ("Lightsheet", "Darkfield", "3D view") and none is
// a substring of its opposite, which is what strict matching guards against.
// The opposite-pair scan still covers them.
const PREFIX_MATCHABLE: ReadonlySet<string> = new Set([
  "dark",
  "light",
  "2d",
  "3d",
]);

/** Words the scorer matches only to a whole title word or keyword. */
export const STATE_WORDS: ReadonlySet<string> = new Set(
  OPPOSITE_PAIRS.flat().filter((word) => !PREFIX_MATCHABLE.has(word)),
);

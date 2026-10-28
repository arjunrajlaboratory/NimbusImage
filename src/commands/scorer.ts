import { ICommand } from "./types";
import { synonymsOf } from "./synonyms";
import { STATE_WORDS } from "./stateWords";

// Local, synchronous command matching: no network, no dependency. Scores, from
// strongest: the whole query equals / prefixes the title, then per query word
// a title word-start ("seg" → "Segment"), a run of the title's word initials
// ("cs" → "Add tool: Cellpose-SAM"), a title substring, a title subsequence,
// a keyword, and the description last. Every query word must match somewhere;
// a word may also match through its singular ("objects" → "Object") or a
// synonym, at a discount. A whole query equal to one of a command's aliases
// ranks just below an exact title, and a prefix of one just below a title
// prefix.

/**
 * Lowercase, strip diacritics, and turn punctuation (hyphens too) into spaces.
 * Letters of any script survive: channel names like "α-tubulin" are common.
 * NFKD also folds compatibility forms (the micro sign µ becomes Greek μ).
 */
export function normalize(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

interface IPrepared {
  title: string;
  aliases: string[];
  titleWords: string[];
  initials: string;
  keywordWords: string[];
  description: string;
  descriptionWords: string[];
}

// Commands are rebuilt whenever their provider re-derives, so a WeakMap keyed
// on the object keeps per-keystroke work to the scoring itself.
const preparedCache = new WeakMap<ICommand, IPrepared>();

function prepare(command: ICommand): IPrepared {
  let prepared = preparedCache.get(command);
  if (!prepared) {
    const title = normalize(command.title);
    const titleWords = title.split(" ").filter(Boolean);
    const description = normalize(command.description ?? "");
    prepared = {
      title,
      aliases: (command.aliases ?? []).map(normalize).filter(Boolean),
      titleWords,
      initials: titleWords.map((word) => word[0]).join(""),
      keywordWords: (command.keywords ?? [])
        .flatMap((keyword) => normalize(keyword).split(" "))
        .filter(Boolean),
      description,
      descriptionWords: description.split(" ").filter(Boolean),
    };
    preparedCache.set(command, prepared);
  }
  return prepared;
}

function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0;
  for (const char of haystack) {
    if (char === needle[i]) {
      i++;
      if (i === needle.length) {
        return true;
      }
    }
  }
  return false;
}

// Whole state words in a query (src/commands/stateWords.ts) must name a whole
// title word or keyword. A command whose title flips with state ("Unlock pan
// and zoom", "Unroll Z") would otherwise match the opposite request through a
// substring ("lock", "roll") or a subsequence ("open" in "Close Nimbus AI
// panel"), and do the opposite. A partly typed word ("sho") matches as usual.
function scoreWord(word: string, p: IPrepared): number {
  if (STATE_WORDS.has(word)) {
    if (p.titleWords.includes(word)) {
      return 80;
    }
    return p.keywordWords.includes(word) ? 50 : 0;
  }
  if (p.titleWords.some((titleWord) => titleWord.startsWith(word))) {
    return 80;
  }
  const isMultiChar = word.length >= 2;
  if (isMultiChar && p.initials.includes(word)) {
    return 70;
  }
  if (p.title.includes(word)) {
    return 60;
  }
  if (p.keywordWords.some((keyword) => keyword.startsWith(word))) {
    return 50;
  }
  // Within one title word only ("tbl" → "table"). Across the whole title it
  // found letters scattered over several words: "area" in "dapi blob
  // metrics elongation", so "filter area" ran "Add filter: …Elongation".
  // Cross-word abbreviations are the initials rule above ("cs").
  if (
    isMultiChar &&
    p.titleWords.some((titleWord) => isSubsequence(word, titleWord))
  ) {
    return 30;
  }
  if (p.descriptionWords.some((descWord) => descWord.startsWith(word))) {
    return 25;
  }
  if (isMultiChar && p.description.includes(word)) {
    return 20;
  }
  return 0;
}

const SYNONYM_DISCOUNT = 0.8;
const SINGULAR_DISCOUNT = 0.95;

/** "objects" → "object"; "cells" → "cell". Deliberately naive. */
function singularOf(word: string): string | null {
  return word.length > 3 && word.endsWith("s") && !word.endsWith("ss")
    ? word.slice(0, -1)
    : null;
}

function scoreWordWithSynonyms(word: string, p: IPrepared): number {
  let best = scoreWord(word, p);
  const singular = singularOf(word);
  if (singular) {
    best = Math.max(best, scoreWord(singular, p) * SINGULAR_DISCOUNT);
  }
  for (const synonym of synonymsOf(word)) {
    best = Math.max(best, scoreWord(synonym, p) * SYNONYM_DISCOUNT);
  }
  return best;
}

/** Score of `command` for `query`; 0 means no match. */
export function scoreCommand(command: ICommand, query: string): number {
  const q = normalize(query);
  return q ? scoreNormalized(command, q, q.split(" ")) : 0;
}

function scoreNormalized(command: ICommand, q: string, words: string[]) {
  const p = prepare(command);
  if (p.title === q) {
    return 1000;
  }
  // An alias names the command as exactly as its title does, so it outranks
  // another command whose title merely starts with the word ("filter" →
  // Filters panel, not "Filter …" rows).
  if (p.aliases.includes(q)) {
    return 950;
  }
  if (p.title.startsWith(q)) {
    return 900;
  }
  if (q.length >= 3 && p.aliases.some((alias) => alias.startsWith(q))) {
    return 800;
  }
  let total = 0;
  for (const word of words) {
    const score = scoreWordWithSynonyms(word, p);
    if (score === 0) {
      return 0;
    }
    total += score;
  }
  return total;
}

/**
 * The matching commands, best first, capped at `limit`. Ties go to the
 * shorter title, then to registration order.
 */
export function rankCommands(
  commands: readonly ICommand[],
  query: string,
  limit = 50,
): ICommand[] {
  // Normalized once per keystroke, not once per command.
  const q = normalize(query);
  if (!q) {
    return [];
  }
  const words = q.split(" ");
  return commands
    .map((command, index) => ({
      command,
      index,
      score: scoreNormalized(command, q, words),
    }))
    .filter(({ score }) => score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.command.title.length - b.command.title.length ||
        a.index - b.index,
    )
    .slice(0, limit)
    .map(({ command }) => command);
}

import { ICommand } from "./types";
import { synonymsOf } from "./synonyms";

// Local, synchronous command matching: no network, no dependency. Scores, from
// strongest: the whole query equals / prefixes the title, then per query word
// a title word-start ("seg" → "Segment"), a run of the title's word initials
// ("cs" → "Add tool: Cellpose-SAM"), a title substring, a title subsequence, a keyword, and the
// description last. Every query word must match somewhere; a word may also
// match through a synonym at a discount.

/** Lowercase, strip diacritics, and turn punctuation (hyphens too) into spaces. */
export function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

interface IPrepared {
  title: string;
  titleWords: string[];
  initials: string;
  compactTitle: string;
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
      titleWords,
      initials: titleWords.map((word) => word[0]).join(""),
      compactTitle: titleWords.join(""),
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

function scoreWord(word: string, p: IPrepared): number {
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
  if (isMultiChar && isSubsequence(word, p.compactTitle)) {
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

function scoreWordWithSynonyms(word: string, p: IPrepared): number {
  let best = scoreWord(word, p);
  for (const synonym of synonymsOf(word)) {
    best = Math.max(best, scoreWord(synonym, p) * SYNONYM_DISCOUNT);
  }
  return best;
}

/** Score of `command` for `query`; 0 means no match. */
export function scoreCommand(command: ICommand, query: string): number {
  const q = normalize(query);
  if (!q) {
    return 0;
  }
  const p = prepare(command);
  if (p.title === q) {
    return 1000;
  }
  if (p.title.startsWith(q)) {
    return 900;
  }
  let total = 0;
  for (const word of q.split(" ")) {
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
  return commands
    .map((command, index) => ({
      command,
      index,
      score: scoreCommand(command, query),
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

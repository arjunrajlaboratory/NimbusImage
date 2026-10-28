import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join, relative } from "path";
import { OPPOSITE_PAIRS } from "./stateWords";

// A state-flipping command must carry only the word for what it will do. If
// one array literal holds both words of an opposite pair, a command built
// from it matches the request for the state it already has and does the
// opposite ("light background" turning white black, "add column area"
// removing the column). Three review rounds each found one such array; this
// finds them all. Only single-word string elements count, so phrase lists
// ("hide objects", "show objects") are fine. It reads innermost array
// literals, so an array holding a nested array literal is checked only
// through that inner array.

// Files that list the words on purpose, not as one command's keywords.
const EXEMPT = ["commands/stateWords.ts"];

const srcRoot = join(__dirname, "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(full);
    }
    return /\.(ts|vue)$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)
      ? [full]
      : [];
  });
}

describe("command keyword arrays", () => {
  it("never hold both words of an opposite pair", () => {
    const problems: string[] = [];
    let scanned = 0;
    for (const file of sourceFiles(srcRoot)) {
      const path = relative(srcRoot, file);
      if (EXEMPT.includes(path)) {
        continue;
      }
      const source = readFileSync(file, "utf8");
      for (const [literal] of source.matchAll(/\[[^[\]]*\]/g)) {
        // `cond ? "hide" : "show"` picks one word; it is the fix, not a pair.
        const unconditional = literal.replace(
          /\?\s*"[^"]*"\s*:\s*"[^"]*"/g,
          "",
        );
        const words = new Set(
          [...unconditional.matchAll(/"([^"\s]+)"/g)].map(([, w]) =>
            w.toLowerCase(),
          ),
        );
        if (words.size === 0) {
          continue;
        }
        scanned++;
        for (const [a, b] of OPPOSITE_PAIRS) {
          if (words.has(a) && words.has(b)) {
            problems.push(
              `${path}: ${a}/${b} in ${literal.replace(/\s+/g, " ")}`,
            );
          }
        }
      }
    }
    expect(scanned).toBeGreaterThan(100);
    expect(problems).toEqual([]);
  });
});

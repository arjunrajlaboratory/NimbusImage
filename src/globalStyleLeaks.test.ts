import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join, relative, resolve } from "path";

/**
 * A rule in a NON-scoped `<style>` block whose selector starts with a bare
 * element name applies to the whole application, not just its component. That
 * is almost never what the author meant, and it is hard to trace: the symptom
 * shows up in an unrelated component, and Vuetify 4 puts its own utilities in a
 * cascade layer, so an unlayered leak like this beats `ma-1` / `text-left`
 * regardless of specificity — no utility class can undo it locally.
 *
 * A real case: `AnnotationList.vue` shipped a top-level `td span { text-align:
 * center; margin: auto }`, which centered every table cell in the app. It
 * surfaced only when a new collections table rendered its columns centered under
 * left-aligned headers, and the computed `margin-left: 184.844px` (auto, resolved
 * against flex free space) gave no hint where it came from.
 *
 * Only TOP-LEVEL rules leak. An element selector nested inside a class — the
 * common SCSS shape, e.g. `.custom-file-manager-wrapper { table tr { … } }` — is
 * already scoped by its ancestor and is fine. `@media` / `@supports` / `@layer`
 * wrappers are transparent: they add no selector context, so a rule inside one
 * still leaks.
 */
const KNOWN_LEAKS: Record<string, string[]> = {
  // App shell — deliberately global, and the only remaining top-level case.
  "App.vue": ["body > div"],
};

const ELEMENT_SELECTOR =
  /^(a|body|button|div|h[1-6]|input|label|li|ol|p|span|table|tbody|td|textarea|th|thead|tr|ul|svg|img|canvas)\b/i;

function vueFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...vueFiles(full));
    } else if (entry.name.endsWith(".vue")) {
      out.push(full);
    }
  }
  return out.sort();
}

/**
 * Top-level element selectors in the non-scoped `<style>` blocks of one SFC.
 *
 * Walks the block tracking how many *selector* frames are open, so a nested rule
 * is not reported. At-rule frames don't count, because they scope nothing.
 */
function leakingSelectors(source: string): string[] {
  const found: string[] = [];

  for (const block of source.matchAll(/<style([^>]*)>([\s\S]*?)<\/style>/g)) {
    const [, attrs, body] = block;
    if (/\bscoped\b|\bmodule\b/.test(attrs)) continue;

    // Strip comments so braces inside them cannot unbalance the walk.
    const css = body
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^[ \t]*\/\/.*$/gm, "");

    const frames: ("selector" | "at-rule")[] = [];
    let pending = "";

    for (const char of css) {
      if (char === "{") {
        const selector = pending.replace(/\s+/g, " ").trim();
        const isAtRule = selector.startsWith("@");
        const selectorDepth = frames.filter((f) => f === "selector").length;

        if (!isAtRule && selectorDepth === 0) {
          for (const part of selector.split(",").map((s) => s.trim())) {
            if (ELEMENT_SELECTOR.test(part)) {
              found.push(part);
              break;
            }
          }
        }
        frames.push(isAtRule ? "at-rule" : "selector");
        pending = "";
      } else if (char === "}") {
        frames.pop();
        pending = "";
      } else if (char === ";") {
        pending = "";
      } else {
        pending += char;
      }
    }
  }

  return found;
}

describe("global style leaks", () => {
  it("adds no new app-wide element selectors in non-scoped style blocks", () => {
    const srcRoot = resolve(process.cwd(), "src");
    const unexpected: string[] = [];

    for (const file of vueFiles(srcRoot)) {
      const key = relative(srcRoot, file).split(/[/\\]/).join("/");
      const allowed = KNOWN_LEAKS[key] ?? [];
      for (const selector of leakingSelectors(readFileSync(file, "utf8"))) {
        if (!allowed.includes(selector)) {
          unexpected.push(`${key}: ${selector}`);
        }
      }
    }

    expect(unexpected).toEqual([]);
  });

  it("keeps the known-leak list honest — no entries that no longer exist", () => {
    const srcRoot = resolve(process.cwd(), "src");
    const stale: string[] = [];

    for (const [key, selectors] of Object.entries(KNOWN_LEAKS)) {
      const present = leakingSelectors(
        readFileSync(join(srcRoot, key), "utf8"),
      );
      for (const selector of selectors) {
        if (!present.includes(selector)) {
          stale.push(`${key}: ${selector} — fixed, delete it from KNOWN_LEAKS`);
        }
      }
    }

    expect(stale).toEqual([]);
  });

  // Guards the walker itself: if nesting detection breaks, the first test would
  // silently stop reporting real leaks rather than fail.
  it("reports top-level element rules but not nested or scoped ones", () => {
    const leaks = (css: string) => leakingSelectors(css);

    expect(leaks("<style>td span { color: red }</style>")).toEqual(["td span"]);
    expect(leaks("<style scoped>td span { color: red }</style>")).toEqual([]);
    expect(leaks("<style>.panel { td span { color: red } }</style>")).toEqual(
      [],
    );
    // At-rules scope nothing, so a rule inside one still leaks.
    expect(
      leaks(
        "<style>@media (min-width: 1px) { td span { color: red } }</style>",
      ),
    ).toEqual(["td span"]);
    // A comment containing a brace must not unbalance the walk.
    expect(
      leaks("<style>/* { */ .panel { td { color: red } }</style>"),
    ).toEqual([]);
    // Class-led selectors are never reported, at any depth.
    expect(leaks("<style>.a td span { color: red }</style>")).toEqual([]);
  });
});

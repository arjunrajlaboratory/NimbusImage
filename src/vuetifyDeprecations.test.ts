import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join, dirname, relative } from "path";
import { fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = here;

function allVueFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".vue")) {
        out.push(full);
      }
    }
  };
  walk(srcRoot);
  return out.sort();
}

// Matches an opening tag and captures its attribute blob. Quoted values are
// consumed wholesale so a ">" inside an attribute (e.g. `:x="a > b"`) does not
// end the match early, and the blob may span newlines so multi-line tags are
// covered. HTML comments never match because "!" is not in [a-z].
const OPEN_TAG = /<([a-z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)\/?>/g;

// A standalone boolean `dense` attribute. `density="…"` does not match, because
// the character after `dense` must be whitespace, "=", or the blob's end.
const BOOLEAN_DENSE = /(^|\s)dense(\s|=|$)/;

function densePlaces(source: string): string[] {
  // Drop HTML comments so prose mentioning "dense" is not scanned as markup.
  const stripped = source.replace(/<!--[\s\S]*?-->/g, "");
  const found: string[] = [];
  for (const match of stripped.matchAll(OPEN_TAG)) {
    if (BOOLEAN_DENSE.test(match[2])) {
      found.push(match[1]);
    }
  }
  return found;
}

describe("Vuetify 4 deprecations", () => {
  // Vuetify 4 deprecated the boolean `dense` prop. VRow still honours it but
  // logs `[Vuetify UPGRADE] 'dense' is deprecated` on every render; every
  // other component in this app never had a `dense` prop at all, so there the
  // attribute silently falls through to the DOM as dead markup.
  //
  // Fix: on `<v-row>` use `density="comfortable"` (identical rendered class —
  // VRow maps both to `v-row--density-comfortable`). Anywhere else, delete the
  // attribute; do not swap in `density`, which is either equally dead or a new
  // unintended visual change.
  it("no component uses the deprecated boolean `dense` prop", () => {
    const offenders: string[] = [];
    for (const file of allVueFiles()) {
      for (const tag of densePlaces(readFileSync(file, "utf8"))) {
        offenders.push(`${relative(srcRoot, file)}: <${tag} dense>`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the scanner detects `dense` but not `density`", () => {
    expect(densePlaces(`<v-row class="my-0" dense>`)).toEqual(["v-row"]);
    expect(densePlaces(`<v-row\n  class="my-0"\n  dense\n>`)).toEqual([
      "v-row",
    ]);
    expect(densePlaces(`<v-row density="comfortable">`)).toEqual([]);
    expect(densePlaces(`<!-- the slider is dense -->`)).toEqual([]);
    expect(densePlaces(`<v-col :label="a > b ? 'dense' : ''">`)).toEqual([]);
  });
});

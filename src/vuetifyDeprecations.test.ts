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

// Only the SFC's template block is markup. Scoping to it lets the tag pattern
// accept PascalCase without TypeScript generics in <script> (`ref<VForm>()`,
// `Ref<PaletteRefEl | undefined>`) being mistaken for component tags.
function templateBlock(source: string): string {
  const start = source.indexOf("<template>");
  const end = source.lastIndexOf("</template>");
  return start === -1 || end <= start ? "" : source.slice(start, end);
}

// Matches an opening tag and captures its attribute blob. Quoted values are
// consumed wholesale so a ">" inside an attribute (e.g. `:x="a > b"`) does not
// end the match early, and the blob may span newlines so multi-line tags are
// covered. HTML comments never match because "!" is not in [A-Za-z].
// The tag name accepts both `<v-row>` and `<VRow>` — both are valid Vue, and a
// guard that sees only one spelling would pass while the deprecation returns.
const OPEN_TAG = /<([A-Za-z][a-zA-Z0-9.-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)\/?>/g;

// A `dense` attribute in any binding form: bare, `dense="true"`, `:dense="x"`,
// or `v-bind:dense="x"`. `density="…"` never matches, because the character
// after `dense` must be whitespace, "=", or the blob's end.
const DENSE_ATTR = /(^|\s)(?::|v-bind:)?dense(?=[\s=]|$)/;

// Attribute *values* are not attribute names: `class="a dense b"` must not
// register, so blank the quoted spans before looking for the token.
function attrNames(blob: string): string {
  return blob.replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''");
}

function densePlaces(source: string): string[] {
  // Drop HTML comments so prose mentioning "dense" is not scanned as markup.
  const stripped = templateBlock(source).replace(/<!--[\s\S]*?-->/g, "");
  const found: string[] = [];
  for (const match of stripped.matchAll(OPEN_TAG)) {
    if (DENSE_ATTR.test(attrNames(match[2]))) {
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
  it("no component uses the deprecated `dense` prop", () => {
    const offenders: string[] = [];
    for (const file of allVueFiles()) {
      for (const tag of densePlaces(readFileSync(file, "utf8"))) {
        offenders.push(`${relative(srcRoot, file)}: <${tag} dense>`);
      }
    }
    expect(offenders).toEqual([]);
  });

  // A guard that silently inspects nothing passes forever. If the template
  // extraction or the tag pattern ever breaks, this fails instead of the
  // check above quietly going vacuous.
  it("actually scans the component tree", () => {
    const files = allVueFiles();
    expect(files.length).toBeGreaterThan(100);

    const withoutTemplate = files.filter(
      (f) => !templateBlock(readFileSync(f, "utf8")),
    );
    expect(withoutTemplate.map((f) => relative(srcRoot, f))).toEqual([]);

    const tags = files.reduce(
      (n, f) =>
        n +
        [...templateBlock(readFileSync(f, "utf8")).matchAll(OPEN_TAG)].length,
      0,
    );
    expect(tags).toBeGreaterThan(1000);
  });

  it("detects `dense` in every binding form, on either tag spelling", () => {
    const t = (markup: string) => densePlaces(`<template>${markup}</template>`);

    // bare boolean, kebab-case and PascalCase tags
    expect(t(`<v-row class="my-0" dense>`)).toEqual(["v-row"]);
    expect(t(`<VRow class="my-0" dense>`)).toEqual(["VRow"]);
    expect(t(`<v-list-subheader dense>x</v-list-subheader>`)).toEqual([
      "v-list-subheader",
    ]);
    // multi-line tag, attribute on its own line
    expect(t(`<v-row\n  class="my-0"\n  dense\n>`)).toEqual(["v-row"]);
    expect(t(`<VRow\n  dense\n/>`)).toEqual(["VRow"]);
    // explicit and bound forms
    expect(t(`<v-row dense="true">`)).toEqual(["v-row"]);
    expect(t(`<v-row :dense="isDense">`)).toEqual(["v-row"]);
    expect(t(`<v-row v-bind:dense="isDense">`)).toEqual(["v-row"]);
    // custom components, which the issue's `<v-[a-z-]+` regex missed entirely
    expect(t(`<tag-picker v-model="t" dense />`)).toEqual(["tag-picker"]);
  });

  it("does not fire on look-alikes", () => {
    const t = (markup: string) => densePlaces(`<template>${markup}</template>`);

    expect(t(`<v-row density="comfortable">`)).toEqual([]);
    expect(t(`<v-checkbox density="compact" />`)).toEqual([]);
    expect(t(`<!-- the slider is dense -->`)).toEqual([]);
    // "dense" appearing inside an attribute *value*, not as a prop name
    expect(t(`<v-col class="a dense b">`)).toEqual([]);
    expect(t(`<v-col :label="a > b ? 'dense' : ''">`)).toEqual([]);
    expect(t(`<v-col :x="{ dense: true }">`)).toEqual([]);
    // script-block generics are outside the template and must be ignored
    expect(
      densePlaces(`<script setup>const r = ref<Dense>();</script>`),
    ).toEqual([]);
  });
});

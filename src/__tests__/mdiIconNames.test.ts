import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

/**
 * Every `mdi-*` name the app renders must exist in the PINNED `@mdi/font`.
 *
 * A name that doesn't resolve fails silently and invisibly: Vuetify sets the
 * class, the font has no glyph for it, and the icon renders as empty space.
 * `tsc`, lint and every component test stay green, and the only symptom is a
 * blank gap a human has to notice in a screenshot — which is exactly how this
 * was found (a "Color by Property…" menu item shipped with no icon).
 *
 * The trap is that `@mdi/font` here is 5.9.55 while the MDI website documents a
 * far newer set, so a name copied from current docs, or recalled from memory,
 * is likely to be one that does not exist yet. This sweep found three more:
 * `mdi-sitemap-outline` (added after 5.x, used in two places) and `mdi-save`
 * (renamed to `mdi-content-save` in 5.x).
 */
const FONT_CSS = resolve(
  __dirname,
  "../../node_modules/@mdi/font/css/materialdesignicons.css",
);
const SRC_DIR = resolve(__dirname, "..");

/**
 * This file is the one place under `src/` that legitimately names icons which do
 * not exist — it documents the ones this sweep caught — so it must not scan
 * itself.
 */
const SELF = resolve(__dirname, "mdiIconNames.test.ts");

/** Names the installed font actually defines a glyph for. */
function installedIconNames(): Set<string> {
  const css = readFileSync(FONT_CSS, "utf8");
  return new Set(
    [...css.matchAll(/^\.(mdi-[a-z0-9-]+)::before/gm)].map((m) => m[1]),
  );
}

/**
 * A literal icon name. Dynamic names are skipped rather than mangled: the
 * template literal `` `mdi-arrow-${top ? "top" : "bottom"}-…` `` matches only
 * its prefix `mdi-arrow`, which is not an icon and would be reported as
 * missing. A fully dynamic `` `mdi-${name}` `` never matches at all, since the
 * pattern requires a literal character after the dash.
 */
const ICON_REFERENCE = /\bmdi-[a-z0-9]+(?:-[a-z0-9]+)*/g;

function iconNamesIn(source: string): string[] {
  const names: string[] = [];
  for (const match of source.matchAll(ICON_REFERENCE)) {
    const after = source.slice(
      match.index + match[0].length,
      match.index + match[0].length + 2,
    );
    if (after.startsWith("-$") || after.startsWith("${")) {
      continue; // interpolated suffix — only the prefix is literal
    }
    names.push(match[0]);
  }
  return names;
}

/** Every icon name referenced anywhere under `src/`, with where it came from. */
function referencedIcons(): Map<string, string[]> {
  const byName = new Map<string, string[]>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (full === SELF) {
        continue;
      }
      if (!entry.endsWith(".vue") && !entry.endsWith(".ts")) {
        continue;
      }
      const relative = full.slice(SRC_DIR.length + 1);
      for (const name of iconNamesIn(readFileSync(full, "utf8"))) {
        const sites = byName.get(name) ?? [];
        if (!sites.includes(relative)) {
          sites.push(relative);
        }
        byName.set(name, sites);
      }
    }
  };
  walk(SRC_DIR);
  return byName;
}

describe("mdi icon names", () => {
  // Guards the two halves of the discovery. Without these, an empty font set
  // would fail every name at once (reading as "the whole app is broken" rather
  // than "the CSS moved"), and an empty reference set would pass vacuously.
  it("reads the installed font's icon list", () => {
    const installed = installedIconNames();
    expect(installed.size).toBeGreaterThan(5000);
    expect(installed.has("mdi-palette")).toBe(true);
  });

  it("finds the icons referenced across src", () => {
    const referenced = referencedIcons();
    expect(referenced.size).toBeGreaterThan(100);
    // Icon-only buttons, so a blank glyph leaves no label behind to hint at
    // what the control does.
    expect(referenced.has("mdi-ruler-square")).toBe(true);
    expect(referenced.has("mdi-palette")).toBe(true);
  });

  it("skips interpolated names instead of reporting their prefix", () => {
    expect(iconNamesIn('`mdi-arrow-${top ? "top" : "bottom"}-left`')).toEqual(
      [],
    );
    expect(iconNamesIn("`mdi-${iconName}`")).toEqual([]);
    expect(iconNamesIn("<v-icon>mdi-palette</v-icon>")).toEqual([
      "mdi-palette",
    ]);
  });

  it("references only icons the installed font defines", () => {
    const installed = installedIconNames();
    const missing = [...referencedIcons().entries()]
      .filter(([name]) => !installed.has(name))
      .map(([name, sites]) => `${name} (${sites.join(", ")})`);
    expect(
      missing,
      `These names have no glyph in @mdi/font ${
        JSON.parse(
          readFileSync(
            resolve(__dirname, "../../node_modules/@mdi/font/package.json"),
            "utf8",
          ),
        ).version
      }, so they render as blank space. Check the name against ` +
        `node_modules/@mdi/font/css/materialdesignicons.css rather than the MDI ` +
        `website, which documents a much newer set:\n  ${missing.join("\n  ")}`,
    ).toEqual([]);
  });
});

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

/**
 * The regression checklist in `codebaseDocumentation/CONNECTION_LIST.md` says
 * every invariant must name the test that holds it — "an invariant without a test
 * is a wish". Nothing enforced that, and it rotted exactly as you would expect:
 * a review round renamed two tests and left the checklist citing the old names,
 * while a superseded row was left in place ABOVE its replacement rather than
 * removed, so the list carried two contradictory rules for the same behaviour and
 * a future change could not satisfy both.
 *
 * This makes the property mechanical. It does not check that the tests are good,
 * only that the names resolve — which is the part that silently decays.
 */
const CHECKLIST = resolve(
  __dirname,
  "../../codebaseDocumentation/CONNECTION_LIST.md",
);

/** Every `*"..."*` citation inside the checklist section. */
function citedTestNames(): string[] {
  const doc = readFileSync(CHECKLIST, "utf8");
  const start = doc.indexOf("### Drawing");
  expect(start).toBeGreaterThan(-1);
  return [...new Set(doc.slice(start).match(/\*"[^"]+"\*/g) ?? [])].map((m) =>
    m.slice(2, -2),
  );
}

function allTestSources(): string {
  const root = resolve(__dirname, "..");
  const parts: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry !== "node_modules") walk(full);
      } else if (entry.endsWith(".test.ts")) {
        parts.push(readFileSync(full, "utf8"));
      }
    }
  };
  walk(root);
  return parts.join("\n");
}

describe("CONNECTION_LIST regression checklist", () => {
  it("cites a non-trivial number of tests", () => {
    // Guards the extraction: a regex that stopped matching would make the
    // assertion below vacuously true.
    expect(citedTestNames().length).toBeGreaterThan(50);
  });

  it("names only tests that exist", () => {
    const sources = allTestSources();
    const missing = citedTestNames().filter((name) => {
      // A trailing ellipsis is a deliberate abbreviation in the doc; match the
      // part before it. `%s` marks an it.each template, which is literal in the
      // source even though the reported title is not.
      const probe = name.split("…")[0].trim();
      return probe.length > 0 && !sources.includes(probe);
    });
    expect(
      missing,
      `The checklist cites tests that no longer exist. Renaming a test means ` +
        `updating the invariant that names it, or the checklist stops being ` +
        `checkable:\n  ${missing.join("\n  ")}`,
    ).toEqual([]);
  });

  it("has no unchecked-off duplicate invariants for the same behaviour", () => {
    // Two rows prescribing different rules for one behaviour is unsatisfiable.
    // Caught in review once already, for the track-framing Time rule, where the
    // replacement was added ABOVE the row it superseded instead of replacing it.
    const doc = readFileSync(CHECKLIST, "utf8");
    const bolds = [...doc.matchAll(/^- \[ \] \*\*(.+?)\*\*/gm)].map(
      (m) => m[1],
    );
    expect(new Set(bolds).size).toBe(bolds.length);
  });
});

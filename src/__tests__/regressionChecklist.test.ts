import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

/**
 * Feature docs under `codebaseDocumentation/` carry a "Regression checklist" whose
 * rule is that every invariant names the test that holds it — "an invariant without
 * a test is a wish". Nothing enforced that, and `CONNECTION_LIST.md` rotted exactly
 * as you would expect: a review round renamed two tests and left the checklist
 * citing the old names, while a superseded row was left in place ABOVE its
 * replacement rather than removed, so the list carried two contradictory rules for
 * the same behaviour and a future change could not satisfy both.
 *
 * This makes the property mechanical. It does not check that the tests are good,
 * only that the names resolve — which is the part that silently decays.
 *
 * Applied to EVERY doc with a checklist, discovered rather than listed: the first
 * version of this test hardcoded `CONNECTION_LIST.md`, so the next feature to grow
 * a checklist (`UNROLL_NAVIGATION.md`) was unprotected by the very mechanism added
 * to protect checklists.
 */
const DOCS_DIR = resolve(__dirname, "../../codebaseDocumentation");
const CHECKLIST_HEADING = "## Regression checklist";

function checklistDocs(): { name: string; body: string }[] {
  return readdirSync(DOCS_DIR)
    .filter((entry) => entry.endsWith(".md"))
    .map((name) => ({
      name,
      body: readFileSync(join(DOCS_DIR, name), "utf8"),
    }))
    .filter((doc) => doc.body.includes(CHECKLIST_HEADING));
}

/**
 * Collapse runs of whitespace. Citations wrap across lines in the docs (prose is
 * hard-wrapped), so the raw match carries a newline plus indentation that the
 * single-line string literal in the test source does not.
 */
function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Every `*"..."*` citation at or below the checklist heading. */
function citedTestNames(body: string): string[] {
  const start = body.indexOf(CHECKLIST_HEADING);
  expect(start).toBeGreaterThan(-1);
  return [
    ...new Set(
      (body.slice(start).match(/\*"[^"]+"\*/g) ?? []).map((m) =>
        normalize(m.slice(2, -2)),
      ),
    ),
  ];
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

describe("regression checklists", () => {
  // Guards the discovery: if the heading were renamed, every per-doc assertion
  // below would vacuously pass on an empty list.
  it("finds the docs that carry a checklist", () => {
    const names = checklistDocs().map((doc) => doc.name);
    expect(names).toContain("CONNECTION_LIST.md");
    expect(names).toContain("UNROLL_NAVIGATION.md");
  });

  it("cites a non-trivial number of tests overall", () => {
    // Guards the extraction: a regex that stopped matching would make the
    // per-doc assertions vacuously true.
    const total = checklistDocs().reduce(
      (sum, doc) => sum + citedTestNames(doc.body).length,
      0,
    );
    expect(total).toBeGreaterThan(50);
  });

  describe.each(checklistDocs())("$name", ({ body }) => {
    it("cites at least a few tests", () => {
      expect(citedTestNames(body).length).toBeGreaterThan(4);
    });

    it("names only tests that exist", () => {
      const sources = normalize(allTestSources());
      const missing = citedTestNames(body).filter((name) => {
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
      const bolds = [...body.matchAll(/^- \[ \] \*\*(.+?)\*\*/gm)].map(
        (m) => m[1],
      );
      expect(new Set(bolds).size).toBe(bolds.length);
    });
  });
});

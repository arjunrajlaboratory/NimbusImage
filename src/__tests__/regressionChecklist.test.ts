import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
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

/**
 * Every test tree this repo OWNS, and how each names its tests. Checklists are not
 * frontend-only, and a doc citing a test in a tree missing from here would fail with
 * "test does not exist" while the test existed.
 *
 * Listed explicitly rather than walked from the repo root with an exclude list,
 * because the two failure modes are not symmetric: a missing ROOT fails loudly and
 * obviously, while a missing EXCLUDE lets a citation resolve against vendored
 * third-party tests and pass for the wrong reason. `nimbusimage/` alone holds 877
 * `test_*.py` files — 24 ours, the rest inside `.venv`.
 *
 * `knownTest` pins one real test per root, so a root that stops being scanned fails
 * against that root's own sources instead of silently resolving against another
 * tree or reporting every citation into it as missing.
 */
const PYTEST = (f: string) => f.startsWith("test_") && f.endsWith(".py");
const TEST_ROOTS = [
  {
    dir: resolve(__dirname, ".."),
    matches: (f: string) => f.endsWith(".test.ts"),
    knownTest: "names only tests that exist",
  },
  // Girder plugin (backend).
  {
    dir: resolve(__dirname, "../../devops"),
    matches: PYTEST,
    knownTest: "testAnnotationSchema",
  },
  // The `nimbusimage` Python package — its `.venv` is skipped by NOT_OURS.
  {
    dir: resolve(__dirname, "../../nimbusimage/tests"),
    matches: PYTEST,
    knownTest: "test_connect_with_token",
  },
  // Repo tooling, e.g. the skills-mirror sync script.
  {
    dir: resolve(__dirname, "../../plugins"),
    matches: PYTEST,
    knownTest: "test_accepts_codex_marketplace_contract",
  },
];
type TestRoot = (typeof TEST_ROOTS)[number];

/** Directories holding code this repo does not own. */
const NOT_OURS = new Set([
  "node_modules",
  ".tox",
  ".venv",
  "__pycache__",
  ".pnpm-store",
  // Review worktrees are checkouts of this repo, not part of it.
  ".claude",
]);

/**
 * Every directory in the repo that holds an owned `test_*.py`, found from the
 * filesystem rather than from `TEST_ROOTS`.
 *
 * This is the completeness half of the guard. The per-root assertions below catch a
 * root that stops resolving, but not a root DELETED from the list — `it.each` simply
 * generates one case fewer, which passes. Deriving the expectation from disk catches
 * both that and a brand-new owned test tree nobody added.
 *
 * Only used to check coverage, never to resolve citations, so walking broadly here
 * cannot cause a citation to match vendored code.
 */
function ownedPytestDirs(): string[] {
  const repoRoot = resolve(__dirname, "../..");
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (!NOT_OURS.has(entry) && entry !== ".git") {
          walk(full);
        }
      } else if (PYTEST(entry) && !found.includes(dir)) {
        found.push(dir);
      }
    }
  };
  walk(repoRoot);
  return found;
}

const cachedRootSources = new WeakMap<TestRoot, string>();

/** Read one configured root once, independently from every other test tree. */
function testSources(root: TestRoot): string {
  const cached = cachedRootSources.get(root);
  if (cached !== undefined) {
    return cached;
  }
  const parts: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (!NOT_OURS.has(entry)) {
          walk(full);
        }
      } else if (root.matches(entry)) {
        parts.push(readFileSync(full, "utf8"));
      }
    }
  };
  if (existsSync(root.dir)) {
    walk(root.dir);
  }
  const sources = normalize(parts.join("\n"));
  cachedRootSources.set(root, sources);
  return sources;
}

/** Read once: this is a whole-tree walk, and it is the same for every doc. */
let cachedSources: string | null = null;

function allTestSources(): string {
  if (cachedSources === null) {
    cachedSources = normalize(TEST_ROOTS.map(testSources).join("\n"));
  }
  return cachedSources;
}

describe("regression checklists", () => {
  // Guards the discovery: if the heading were renamed, every per-doc assertion
  // below would vacuously pass on an empty list.
  it("finds the docs that carry a checklist", () => {
    const names = checklistDocs().map((doc) => doc.name);
    expect(names).toContain("CONNECTION_LIST.md");
    expect(names).toContain("UNROLL_NAVIGATION.md");
  });

  // Guards the discovery of test SOURCES the same way. Without this, a root that
  // stopped being scanned would not fail here — it would fail as "the checklist
  // cites tests that no longer exist" in whichever doc happened to cite into it,
  // which reads as a documentation problem rather than a discovery one.
  it.each(
    TEST_ROOTS.map((root) => [root.dir.split("/").slice(-2).join("/"), root]),
  )("scans %s", (_label, root) => {
    expect(
      existsSync(root.dir),
      `${root.dir} is gone — update TEST_ROOTS`,
    ).toBe(true);
    expect(testSources(root)).toContain(root.knownTest);
  });

  it("does not let another root satisfy a broken root probe", () => {
    const backendRoot = TEST_ROOTS.find((root) => root.dir.endsWith("/devops"));
    if (!backendRoot) {
      throw new Error("devops test root is not configured");
    }
    expect(testSources({ ...backendRoot, matches: () => false })).not.toContain(
      backendRoot.knownTest,
    );
  });

  // Catches a root deleted from TEST_ROOTS, and an owned test tree nobody added —
  // neither of which the per-root cases above can see.
  it("leaves no owned pytest tree unscanned", () => {
    const covered = TEST_ROOTS.map((root) => root.dir);
    const unscanned = ownedPytestDirs().filter(
      (dir) =>
        !covered.some((root) => dir === root || dir.startsWith(root + "/")),
    );
    expect(
      unscanned,
      `These directories hold test_*.py that no TEST_ROOTS entry covers, so a ` +
        `checklist citing them would wrongly report the tests as missing:\n  ` +
        `${unscanned.join("\n  ")}`,
    ).toEqual([]);
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
      const sources = allTestSources();
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

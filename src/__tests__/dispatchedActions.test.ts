/**
 * Every `dispatch("name")` in the app must name a real `@Action`.
 *
 * `vuex-module-decorators` registers actions UNNAMESPACED, and Vuex answers a
 * dispatch for an unknown name by logging an error and resolving a no-op
 * promise. So a renamed action leaves its old call sites silently dead: no type
 * error, no test failure, and often no visible symptom because something else
 * happens to trigger the same work. That is exactly how
 * `dispatch("refreshAnalysisGateIds")` survived a rename to `refreshAnalysis` —
 * the configuration-hydration refresh stopped running and was masked by a
 * watcher covering the normal route.
 *
 * Scanning source rather than importing the store keeps this cheap and avoids
 * pulling geojs and friends into the test environment.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

const SRC = join(__dirname, "..");

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, out);
    } else if (
      (entry.endsWith(".ts") || entry.endsWith(".vue")) &&
      !entry.includes(".test.")
    ) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Names declared with `@Action`. The decorator and the method are not always
 * adjacent — a doc comment or a decorator argument can sit between them — so
 * this skips blank/comment/decorator-continuation lines rather than assuming
 * the method is on the very next line.
 */
function declaredActions(files: string[]): Set<string> {
  const declared = new Set<string>();
  const method =
    /^\s*(?:public\s+|private\s+|protected\s+)?(?:async\s+)?([A-Za-z0-9_$]+)\s*\(/;
  for (const file of files) {
    const lines = readFileSync(file, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!/^\s*@Action\b/.test(lines[i])) {
        continue;
      }
      for (let j = i + 1; j < Math.min(i + 12, lines.length); j++) {
        const line = lines[j];
        if (
          line.trim() === "" ||
          line.trim().startsWith("//") ||
          line.trim().startsWith("*") ||
          line.trim().startsWith("/*") ||
          line.trim().startsWith("@") ||
          line.trim().startsWith(")")
        ) {
          continue;
        }
        const match = method.exec(line);
        if (match) {
          declared.add(match[1]);
        }
        break;
      }
    }
  }
  return declared;
}

describe("dispatched action names", () => {
  const files = sourceFiles(SRC);
  const declared = declaredActions(files);

  it("finds the store's actions (guards against the scan silently breaking)", () => {
    // If the extraction regressed, every dispatch would look valid and the
    // real assertion below would pass vacuously.
    expect(declared.size).toBeGreaterThan(100);
    expect(declared).toContain("refreshAnalysis");
    expect(declared).toContain("fetchProperties");
  });

  it("every dispatched name resolves to a declared @Action", () => {
    const unknown: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      const pattern = /dispatch\(\s*["']([A-Za-z0-9_$]+)["']/g;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(text)) !== null) {
        if (!declared.has(match[1])) {
          const line = text.slice(0, match.index).split("\n").length;
          unknown.push(
            `${file.replace(SRC, "src")}:${line} dispatches "${match[1]}"`,
          );
        }
      }
    }
    expect(unknown).toEqual([]);
  });
});

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { load } from "js-yaml";
import {
  ALL_TOUR_ANCHORS,
  ALL_TOUR_TRIGGERS,
  TOUR_ANCHORS,
  TOUR_TRIGGERS,
} from "./anchors";

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, "..");

// Anchors that are intentionally data-dependent (built via getTourAnchorId).
// Tours may target these even though they are not in the static registry.
const DATA_DEPENDENT = new Set<string>([
  "nucleus",
  "dapi-blob",
  "blob",
  "gaussian-blur",
  "sigma",
  "parent-tag",
  "my-first-nimbus-dataset",
]);

function allYamlFiles(): string[] {
  return readdirSync(here)
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => join(here, f));
}

function selectorToAnchor(selector: string): string | null {
  const m = selector.match(/^\[data-tour="([a-z0-9-]+)"\]$/);
  return m ? m[1] : null;
}

function allComponentSource(): string {
  let out = "";
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (
        entry.name === "anchors.ts" ||
        entry.name.endsWith(".test.ts")
      ) {
        // Skip the registry itself and test files so their string values and
        // mocks don't count as component "usage".
        continue;
      } else if (entry.name.endsWith(".vue") || entry.name.endsWith(".ts")) {
        out += readFileSync(full, "utf8");
      }
    }
  };
  walk(srcRoot);
  return out;
}

describe("tour anchors", () => {
  const source = allComponentSource();

  it("every YAML element selector resolves to a known or data-dependent anchor", () => {
    const problems: string[] = [];
    for (const file of allYamlFiles()) {
      const tour: any = load(readFileSync(file, "utf8"));
      for (const step of tour.steps ?? []) {
        if (!step.element) continue;
        const anchor = selectorToAnchor(step.element);
        if (anchor == null) {
          problems.push(
            `${file}: step "${step.id}" selector "${step.element}" is not a [data-tour="..."] selector`,
          );
          continue;
        }
        if (!ALL_TOUR_ANCHORS.has(anchor) && !DATA_DEPENDENT.has(anchor)) {
          problems.push(
            `${file}: step "${step.id}" targets unknown anchor "${anchor}"`,
          );
        }
      }
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });

  it("every YAML onTriggerEvent is a known trigger", () => {
    const problems: string[] = [];
    for (const file of allYamlFiles()) {
      const tour: any = load(readFileSync(file, "utf8"));
      for (const step of tour.steps ?? []) {
        if (!step.onTriggerEvent) continue;
        if (
          !ALL_TOUR_TRIGGERS.has(step.onTriggerEvent) &&
          !DATA_DEPENDENT.has(step.onTriggerEvent)
        ) {
          problems.push(
            `${file}: step "${step.id}" uses unknown trigger "${step.onTriggerEvent}"`,
          );
        }
      }
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });

  it("every registered static anchor is referenced via TOUR_ANCHORS.<key>", () => {
    const unused = Object.keys(TOUR_ANCHORS).filter(
      (key) => !source.includes(`TOUR_ANCHORS.${key}`),
    );
    expect(
      unused,
      `Registered anchors not referenced via TOUR_ANCHORS.<key>: ${unused.join(", ")}`,
    ).toEqual([]);
  });

  it("every registered trigger is referenced via TOUR_TRIGGERS.<key>", () => {
    const unused = Object.keys(TOUR_TRIGGERS).filter(
      (key) => !source.includes(`TOUR_TRIGGERS.${key}`),
    );
    expect(
      unused,
      `Registered triggers not referenced via TOUR_TRIGGERS.<key>: ${unused.join(", ")}`,
    ).toEqual([]);
  });
});

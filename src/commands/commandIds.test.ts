import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join, relative } from "path";

// Every literal `data-command-id="x"` on a control outside App.vue must name a
// command registered in the same component (`id: "x"`, or `commandId: "x"`
// for table-driven registrations). App.vue's ids are checked at runtime by
// App.commands.test.ts, since its panel commands are derived from the panel
// registry rather than written out.

const srcRoot = join(__dirname, "..");

function vueFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      return vueFiles(full);
    }
    return entry.name.endsWith(".vue") ? [full] : [];
  });
}

describe("data-command-id attributes", () => {
  it("name a command registered by the same component", () => {
    const problems: string[] = [];
    let checked = 0;
    for (const file of vueFiles(srcRoot)) {
      if (file.endsWith("App.vue")) {
        continue;
      }
      const source = readFileSync(file, "utf8");
      const [template, script = ""] = source.split("<script setup");
      for (const [, id] of template.matchAll(/\sdata-command-id="([^"]+)"/g)) {
        checked++;
        if (
          !script.includes(`id: "${id}"`) &&
          !script.includes(`commandId: "${id}"`)
        ) {
          problems.push(`${relative(srcRoot, file)}: ${id}`);
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
    expect(problems).toEqual([]);
  });

  it("DataIOMenu registers a command for every menu entry", () => {
    const source = readFileSync(
      join(srcRoot, "components/DataIOMenu.vue"),
      "utf8",
    );
    expect(source).toContain(':data-command-id="entry.commandId"');
    expect(source).toMatch(/useCommand\(\s*DATA_DIALOGS\.map/);
  });
});

import { describe, it, expect } from "vitest";
import {
  examplePlaceholder,
  examplesThatRun,
  paletteExamples,
} from "./examples";

const viewer = {
  inViewer: true,
  isLoggedIn: true,
  zCount: 7,
  timeCount: 1,
  layerNames: ["DAPI", "FITC"],
  propertyNames: ["Elongation", "Area"],
};

const queries = (ctx: typeof viewer) =>
  paletteExamples(ctx).map((example) => example.query);

describe("paletteExamples", () => {
  it("builds viewer examples from the dataset: a real slice, layer and property", () => {
    const examples = paletteExamples(viewer).map((e) => e.query);
    expect(examples).toContain("z 3");
    expect(examples).toContain("show only DAPI");
    expect(examples).toContain("add column Area"); // prefers an Area property
    expect(examples).toContain("merge z");
    // One time point: no time example.
    expect(examples.some((e) => e.startsWith("t "))).toBe(false);
  });

  it("omits examples the dataset can't satisfy", () => {
    const examples = queries({
      ...viewer,
      zCount: 1,
      layerNames: ["DAPI"],
      propertyNames: [],
    });
    expect(
      examples.some((e) => /^z |merge z|show only|add column|color by/.test(e)),
    ).toBe(false);
    expect(examples).toContain("open objects");
  });

  it("never suggests a slice past the end", () => {
    expect(queries({ ...viewer, zCount: 2 })).toContain("z 2");
  });

  it("offers upload off the viewer only when logged in", () => {
    const off = { ...viewer, inViewer: false };
    expect(queries(off)).toContain("upload");
    expect(queries({ ...off, isLoggedIn: false })).not.toContain("upload");
  });
});

describe("examplePlaceholder", () => {
  it("shows three at a time, wrapping around", () => {
    const examples = ["a", "b", "c", "d"];
    expect(examplePlaceholder(examples, 0)).toBe("Try: a · b · c");
    expect(examplePlaceholder(examples, 3)).toBe("Try: d · a · b");
    expect(examplePlaceholder(["a"], 5)).toBe("Try: a");
  });
});

describe("examplesThatRun", () => {
  it("keeps an example only while its top result is the command it shows", () => {
    const examples = [
      { query: "hide objects", target: "objects.toggleDraw" },
      { query: "show objects", target: "objects.toggleDraw" },
    ];
    // Objects visible: "show objects" tops out at the filtered-draw command,
    // which is not what it demonstrates, so only "hide objects" stays.
    const top: Record<string, string> = {
      "hide objects": "objects.toggleDraw",
      "show objects": "objects.toggleFilteredDraw",
    };
    expect(examplesThatRun(examples, (q) => top[q])).toEqual(["hide objects"]);
    expect(examplesThatRun(examples, () => undefined)).toEqual([]);
    expect(examplePlaceholder([], 0)).toBe("Search commands");
  });
});

describe("examples for state-flipping commands", () => {
  it("carry a direction word, so they can't run the opposite", async () => {
    const { STATE_WORDS } = await import("./stateWords");
    const flipping = paletteExamples(viewer).filter((example) => example.flips);
    expect(flipping.length).toBeGreaterThan(3);
    for (const { query } of flipping) {
      const words = query.toLowerCase().split(/\s+/);
      expect(
        words.some((word) => STATE_WORDS.has(word)),
        `"${query}" needs a direction word`,
      ).toBe(true);
    }
  });
});

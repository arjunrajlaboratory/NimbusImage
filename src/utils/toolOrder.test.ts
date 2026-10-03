import { describe, it, expect } from "vitest";
import { IToolConfiguration } from "@/store/model";
import { groupTools, reorderSection } from "./toolOrder";

function tool(id: string, type: string, pinned?: boolean): IToolConfiguration {
  return {
    id,
    name: id,
    type,
    hotkey: null,
    values: {},
    template: {} as any,
    pinned,
  } as IToolConfiguration;
}

const ids = (tools: IToolConfiguration[]) => tools.map(({ id }) => id);

describe("groupTools", () => {
  it("splits tools into pinned, annotation and analysis sections in array order", () => {
    const groups = groupTools([
      tool("a1", "create"),
      tool("w1", "segmentation"),
      tool("a2", "snap", true),
      tool("w2", "segmentation", true),
      tool("a3", "edit"),
    ]);
    expect(groups.map((g) => [g.key, ids(g.tools)])).toEqual([
      ["pinned", ["a2", "w2"]],
      ["annotation", ["a1", "a3"]],
      ["analysis", ["w1"]],
    ]);
  });

  it("omits empty sections and skips missing entries", () => {
    const groups = groupTools([null, tool("w1", "segmentation"), undefined]);
    expect(groups.map((g) => g.key)).toEqual(["analysis"]);
  });

  it("treats pinned: false like an unpinned tool", () => {
    const groups = groupTools([tool("a1", "create", false)]);
    expect(groups.map((g) => g.key)).toEqual(["annotation"]);
  });
});

describe("reorderSection", () => {
  it("refills only the slots the section occupies", () => {
    // Section {a1, a2, a3} interleaved with worker tools w1, w2.
    expect(
      reorderSection(["a1", "w1", "a2", "w2", "a3"], ["a3", "a1", "a2"]),
    ).toEqual(["a3", "w1", "a1", "w2", "a2"]);
  });

  it("returns the same order for an unchanged section", () => {
    expect(reorderSection(["a", "b", "c"], ["a", "c"])).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("rejects a section that names a tool no longer in the toolset", () => {
    expect(reorderSection(["a", "b"], ["b", "gone"])).toBeNull();
  });

  it("rejects a section that repeats a tool", () => {
    expect(reorderSection(["a", "b", "c"], ["a", "a"])).toBeNull();
  });
});

import { describe, it, expect, beforeEach } from "vitest";
import {
  registerPlot,
  getPlot,
  listPlots,
  restorePlots,
  clearPlots,
  IAgentPlot,
} from "./plotRegistry";

// The registry's id counter is module-global and never resets (clearPlots only
// empties the map), so assertions compare ids relative to each other rather
// than against absolute values.
beforeEach(() => {
  clearPlots();
});

const samplePlot = (title = "t"): Omit<IAgentPlot, "id"> => ({
  title,
  data: [],
  layout: {},
});

const idNumber = (id: string) => Number(id.replace("plot-", ""));

describe("plotRegistry", () => {
  it("assigns sequential plot-<n> ids", () => {
    const first = registerPlot(samplePlot());
    const second = registerPlot(samplePlot());
    expect(first.id).toMatch(/^plot-\d+$/);
    expect(idNumber(second.id)).toBe(idNumber(first.id) + 1);
  });

  it("gets by id and lists in insertion order", () => {
    const a = registerPlot(samplePlot("first"));
    const b = registerPlot(samplePlot("second"));
    expect(getPlot(a.id)).toBe(a);
    expect(getPlot(b.id)).toBe(b);
    expect(getPlot("plot-does-not-exist")).toBeUndefined();
    expect(listPlots().map((p) => p.title)).toEqual(["first", "second"]);
  });

  it("clears the registry", () => {
    registerPlot(samplePlot());
    clearPlots();
    expect(listPlots()).toEqual([]);
  });

  it("restorePlots replaces contents and advances the counter past ids", () => {
    registerPlot(samplePlot());
    restorePlots([{ id: "plot-40", title: "restored", data: [], layout: {} }]);
    expect(listPlots().map((p) => p.id)).toEqual(["plot-40"]);

    const next = registerPlot(samplePlot());
    expect(idNumber(next.id)).toBeGreaterThan(40);
    expect(getPlot(next.id)).toBe(next);
    expect(getPlot("plot-40")).toBeDefined();
  });
});

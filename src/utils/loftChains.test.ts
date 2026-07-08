import { describe, expect, it, vi } from "vitest";
import { ILoftChainInput, buildLoftChainIndices } from "@/utils/loftChains";
import { computeLoftChains } from "@/utils/loftChainsWorkerClient";

vi.mock("@/utils/log", () => ({
  logWarning: vi.fn(),
  logError: vi.fn(),
}));

function square(
  x: number,
  y: number,
  size: number,
): ILoftChainInput["polygon"] {
  return [
    { x, y },
    { x: x + size, y },
    { x: x + size, y: y + size },
    { x, y: y + size },
  ];
}

function input(delta: Partial<ILoftChainInput>): ILoftChainInput {
  return {
    polygon: delta.polygon ?? square(0, 0, 2),
    depth: delta.depth ?? 0,
    group: delta.group ?? "nucleus",
  };
}

describe("buildLoftChainIndices", () => {
  it("chains overlapping polygons across consecutive depths", () => {
    const chains = buildLoftChainIndices(
      [
        input({ depth: 0 }),
        input({ depth: 1 }),
        input({ depth: 2 }),
        // Disjoint polygon on its own.
        input({ depth: 1, polygon: square(10, 10, 2) }),
      ],
      0,
    );
    expect(chains).toEqual([[0, 1, 2], [3]]);
  });

  it("gives each polygon at most one partner, preferring the best overlap", () => {
    const chains = buildLoftChainIndices(
      [
        // One large polygon below two candidates: a barely-touching one and
        // a fully-contained one. Only the better overlap is chained.
        input({ depth: 0, polygon: square(0, 0, 4) }),
        input({ depth: 1, polygon: square(3.5, 0, 2) }),
        input({ depth: 1, polygon: square(1, 1, 2) }),
      ],
      0,
    );
    expect(chains).toEqual([[0, 2], [1]]);
  });

  it("applies the minimum overlap fraction", () => {
    const inputs = [
      input({ depth: 0 }),
      // Shifted by half the width: 50% overlap of the smaller square.
      input({ depth: 1, polygon: square(1, 0, 2) }),
    ];
    expect(buildLoftChainIndices(inputs, 0.25)).toEqual([[0, 1]]);
    expect(buildLoftChainIndices(inputs, 0.75)).toEqual([[0], [1]]);
  });

  it("does not chain across groups or depth gaps", () => {
    const chains = buildLoftChainIndices(
      [
        input({ depth: 0, group: "nucleus" }),
        input({ depth: 1, group: "cell" }),
        input({ depth: 2, group: "nucleus" }),
      ],
      0,
    );
    expect(chains).toEqual([[0], [1], [2]]);
  });
});

describe("computeLoftChains", () => {
  it("falls back to synchronous matching when workers are unavailable", async () => {
    // vitest's environment has no Worker global, exercising the fallback.
    expect(typeof Worker).toBe("undefined");
    const chains = await computeLoftChains(
      [input({ depth: 0 }), input({ depth: 1 })],
      0,
    );
    expect(chains).toEqual([[0, 1]]);
  });
});

import { describe, it, expect } from "vitest";
import { clamp } from "@/utils/math";

describe("clamp", () => {
  it("returns the value unchanged when within bounds", () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });

  it("clamps to the lower bound when below", () => {
    expect(clamp(-3, 0, 10)).toBe(0);
  });

  it("clamps to the upper bound when above", () => {
    expect(clamp(42, 0, 10)).toBe(10);
  });

  it("returns the bound at the edges", () => {
    expect(clamp(0, 0, 10)).toBe(0);
    expect(clamp(10, 0, 10)).toBe(10);
  });

  it("supports fractional bounds", () => {
    expect(clamp(1.5, 0, 1)).toBe(1);
    expect(clamp(0.25, 0, 1)).toBe(0.25);
  });
});

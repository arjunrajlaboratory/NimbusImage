import { describe, it, expect } from "vitest";
import { convertLength, formatLength } from "./conversion";

describe("convertLength", () => {
  it("converts between length units", () => {
    expect(convertLength(1, "m", "mm")).toBe(1000);
    expect(convertLength(2500, "nm", "µm")).toBe(2.5);
  });
});

describe("formatLength", () => {
  it("keeps values in a readable unit", () => {
    expect(formatLength(65, "µm")).toBe("65.0 µm");
    expect(formatLength(0.5, "µm")).toBe("500 nm");
    expect(formatLength(1234, "µm")).toBe("1.23 mm");
    expect(formatLength(3, "m")).toBe("3.00 m");
  });

  it("falls back to the smallest unit for tiny values", () => {
    expect(formatLength(0.4, "nm")).toBe("0.400 nm");
  });
});

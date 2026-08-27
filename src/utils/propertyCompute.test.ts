import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/store/properties", () => ({
  default: {
    propertyStatuses: {},
    computeProperty: vi.fn(),
  },
}));

import propertyStore from "@/store/properties";
import { computePropertyWithStatus } from "./propertyCompute";

const property = { id: "property-1", name: "Area" } as any;

describe("computePropertyWithStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (propertyStore as any).propertyStatuses = {};
  });

  it("returns the store promise so callers can observe completion", () => {
    const computePromise = Promise.resolve({ jobId: "job-1" });
    (propertyStore.computeProperty as any).mockReturnValue(computePromise);

    const result = computePropertyWithStatus(property);

    expect(result).toBe(computePromise);
  });
});

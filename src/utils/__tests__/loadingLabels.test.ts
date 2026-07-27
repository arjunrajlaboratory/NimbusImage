import { describe, it, expect } from "vitest";
import {
  annotationLoadingTitle,
  listQueryingMessage,
} from "@/utils/loadingLabels";

describe("annotationLoadingTitle", () => {
  it("formats a large count with locale separators and the plural noun", () => {
    expect(annotationLoadingTitle(708983)).toBe(
      `Loading ${(708983).toLocaleString()} annotations…`,
    );
  });

  it("uses the singular noun for a count of 1", () => {
    expect(annotationLoadingTitle(1)).toBe("Loading 1 annotation…");
  });

  it("uses the plural noun for a count of 0", () => {
    expect(annotationLoadingTitle(0)).toBe("Loading 0 annotations…");
  });

  it("omits the count when it is unknown (count failed → Infinity)", () => {
    // fetchAnnotations passes Infinity when the count request failed and it
    // falls back to stub-only mode; the bar shouldn't say "Infinity".
    expect(annotationLoadingTitle(Infinity)).toBe("Loading annotations…");
  });
});

describe("listQueryingMessage", () => {
  it("includes the total (plural) when it is known", () => {
    expect(listQueryingMessage(708983)).toBe(
      `Querying ${(708983).toLocaleString()} annotations…`,
    );
  });

  it("uses the singular noun for a total of 1", () => {
    expect(listQueryingMessage(1)).toBe("Querying 1 annotation…");
  });

  it("omits the count when the total is not yet known (0)", () => {
    expect(listQueryingMessage(0)).toBe("Querying annotations…");
  });

  it("omits the count for a negative/unset total", () => {
    expect(listQueryingMessage(-1)).toBe("Querying annotations…");
  });
});

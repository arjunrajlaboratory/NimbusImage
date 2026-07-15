import { describe, it, expect, vi } from "vitest";

// PropertiesAPI -> @/utils/fetch -> @/store/progress -> @/store root, which
// creates a circular import when the API class is loaded in isolation. Mock
// the fetch util (unused by getUncomputedCounts) to break that chain.
vi.mock("@/utils/fetch", () => ({ fetchAllPages: vi.fn() }));

import PropertiesAPI from "./PropertiesAPI";
import type { IAnnotationProperty } from "./model";

const makeProperty = (
  id: string,
  shape: string,
  tags: string[],
  exclusive: boolean,
): IAnnotationProperty =>
  ({
    id,
    name: id,
    image: "img",
    shape,
    tags: { tags, exclusive },
    workerInterface: {},
  }) as unknown as IAnnotationProperty;

describe("PropertiesAPI.getUncomputedCounts", () => {
  it("POSTs the dataset id and reduced property specs and returns the counts", async () => {
    const post = vi.fn().mockResolvedValue({ data: { p1: 3, p2: 0 } });
    const api = new PropertiesAPI({ post } as any);

    const result = await api.getUncomputedCounts("dataset-1", [
      makeProperty("p1", "point", ["nucleus"], false),
      makeProperty("p2", "polygon", [], true),
    ]);

    expect(post).toHaveBeenCalledWith("upenn_annotation/uncomputed_counts", {
      datasetId: "dataset-1",
      properties: [
        {
          id: "p1",
          shape: "point",
          tags: { tags: ["nucleus"], exclusive: false },
        },
        { id: "p2", shape: "polygon", tags: { tags: [], exclusive: true } },
      ],
    });
    expect(result).toEqual({ p1: 3, p2: 0 });
  });

  it("returns an empty map without calling the server when there are no properties", async () => {
    const post = vi.fn();
    const api = new PropertiesAPI({ post } as any);

    const result = await api.getUncomputedCounts("dataset-1", []);

    expect(result).toEqual({});
    expect(post).not.toHaveBeenCalled();
  });
});

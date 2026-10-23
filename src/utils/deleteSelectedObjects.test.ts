import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  annotation: {
    isListServerMode: false,
    selectedAnnotationIds: new Set(["a", "b"]),
    deleteAnnotations: vi.fn(async () => {}),
    deleteSelectedAnnotations: vi.fn(),
    setSelected: vi.fn(),
  },
  listServer: { fetchPage: vi.fn(async () => {}) },
}));

vi.mock("@/store/annotation", () => ({ default: mocks.annotation }));
vi.mock("@/store/annotationListServer", () => ({
  default: mocks.listServer,
}));

import { deleteSelectedObjects } from "./deleteSelectedObjects";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("deleteSelectedObjects", () => {
  it("uses the store action in local list mode", async () => {
    mocks.annotation.isListServerMode = false;
    await deleteSelectedObjects();
    expect(mocks.annotation.deleteSelectedAnnotations).toHaveBeenCalled();
    expect(mocks.annotation.deleteAnnotations).not.toHaveBeenCalled();
  });

  it("deletes the selected ids, clears them and refreshes the page in server mode", async () => {
    // The hotkey and palette command used the store action here, which
    // deletes nothing in server mode (the client set is empty).
    mocks.annotation.isListServerMode = true;
    await deleteSelectedObjects();
    expect(mocks.annotation.deleteAnnotations).toHaveBeenCalledWith(["a", "b"]);
    expect(mocks.annotation.setSelected).toHaveBeenCalledWith([]);
    expect(mocks.listServer.fetchPage).toHaveBeenCalled();
    expect(mocks.annotation.deleteSelectedAnnotations).not.toHaveBeenCalled();
  });
});

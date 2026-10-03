import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  store: {
    selectedConfigurationId: "cfg-a" as string | null,
    getCollectionDatasetCount: vi.fn(),
  },
}));

vi.mock("@/store", () => ({ default: h.store }));
vi.mock("@/utils/log", () => ({ logError: vi.fn() }));

import { useCollectionDatasetCount } from "./useCollectionDatasetCount";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.store.selectedConfigurationId = "cfg-a";
});

describe("useCollectionDatasetCount", () => {
  it("revokes batch eligibility while a fresh count is loading", async () => {
    h.store.getCollectionDatasetCount.mockResolvedValueOnce(3);
    const count = useCollectionDatasetCount();
    await count.fetchCollectionDatasetCount();
    expect(count.canApplyToAllDatasets.value).toBe(true);

    const pending = deferred<number>();
    h.store.getCollectionDatasetCount.mockReturnValueOnce(pending.promise);
    const fetchPromise = count.fetchCollectionDatasetCount();

    expect(count.collectionDatasetCount.value).toBe(0);
    expect(count.loadingDatasetCount.value).toBe(true);
    expect(count.canApplyToAllDatasets.value).toBe(false);

    pending.resolve(2);
    await fetchPromise;
    expect(count.canApplyToAllDatasets.value).toBe(true);
  });

  it("ignores an older configuration count that resolves last", async () => {
    const first = deferred<number>();
    const second = deferred<number>();
    h.store.getCollectionDatasetCount.mockImplementation(
      (configurationId: string) =>
        configurationId === "cfg-a" ? first.promise : second.promise,
    );
    const count = useCollectionDatasetCount();

    const firstFetch = count.fetchCollectionDatasetCount();
    h.store.selectedConfigurationId = "cfg-b";
    const secondFetch = count.fetchCollectionDatasetCount();
    second.resolve(4);
    await secondFetch;
    first.resolve(12);
    await firstFetch;

    expect(h.store.getCollectionDatasetCount).toHaveBeenNthCalledWith(
      1,
      "cfg-a",
    );
    expect(h.store.getCollectionDatasetCount).toHaveBeenNthCalledWith(
      2,
      "cfg-b",
    );
    expect(count.collectionDatasetCount.value).toBe(4);
    expect(count.loadingDatasetCount.value).toBe(false);
  });
});

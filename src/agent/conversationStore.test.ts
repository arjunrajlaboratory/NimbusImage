import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach } from "vitest";
import {
  loadStoredConversation,
  saveStoredConversation,
  clearStoredConversation,
  selectPlotsForStorage,
  MAX_STORED_PLOTS,
  MAX_STORED_PLOT_CHARS,
} from "./conversationStore";
import type { IAgentPlot } from "./plotRegistry";
import type { IAgentPanelItem } from "@/store/aiPanel";

beforeEach(async () => {
  await clearStoredConversation();
});

const record = {
  userId: "userA",
  items: [{ kind: "user" as const, text: "hi" }],
  wireMessages: [{ role: "user" as const, content: [] }],
  updatedAt: 1,
};

describe("conversationStore", () => {
  it("returns null when nothing is stored", async () => {
    expect(await loadStoredConversation()).toBeNull();
  });

  it("round-trips a saved conversation", async () => {
    await saveStoredConversation(record);
    const loaded = await loadStoredConversation();
    expect(loaded?.userId).toBe("userA");
    expect(loaded?.items[0].text).toBe("hi");
  });

  it("keeps only the latest record (single slot)", async () => {
    await saveStoredConversation(record);
    await saveStoredConversation({ ...record, userId: "userB" });
    expect((await loadStoredConversation())?.userId).toBe("userB");
  });

  it("clears the stored conversation", async () => {
    await saveStoredConversation(record);
    await clearStoredConversation();
    expect(await loadStoredConversation()).toBeNull();
  });
});

function makePlot(id: string, data: unknown[] = [{ x: [1] }]): IAgentPlot {
  return { id, title: `Plot ${id}`, data, layout: {} };
}

function plotItem(plotId: string): IAgentPanelItem {
  return { kind: "plot", plotId, text: plotId };
}

describe("selectPlotsForStorage", () => {
  it("returns an empty array when no items reference a plot", () => {
    expect(
      selectPlotsForStorage(
        [{ kind: "user", text: "hi" }],
        [makePlot("plot-1")],
      ),
    ).toEqual([]);
    expect(selectPlotsForStorage([], [makePlot("plot-1")])).toEqual([]);
  });

  it("drops plots not referenced by any transcript item", () => {
    const plots = [makePlot("plot-1"), makePlot("plot-2"), makePlot("plot-3")];
    expect(
      selectPlotsForStorage(
        [plotItem("plot-2"), { kind: "assistant", text: "done" }],
        plots,
      ),
    ).toEqual([plots[1]]);
  });

  it("keeps only the newest MAX_STORED_PLOTS in insertion order", () => {
    const plots = Array.from({ length: MAX_STORED_PLOTS + 3 }, (_, i) =>
      makePlot(`plot-${i + 1}`),
    );
    const items = plots.map((plot) => plotItem(plot.id));
    const kept = selectPlotsForStorage(items, plots);
    expect(kept).toHaveLength(MAX_STORED_PLOTS);
    // Registry insertion order is chronological: the LAST 12 survive,
    // still in insertion order.
    expect(kept).toEqual(plots.slice(3));
  });

  it("skips any single plot whose serialized size exceeds the cap", () => {
    const oversize = makePlot("plot-2", ["x".repeat(MAX_STORED_PLOT_CHARS)]);
    const plots = [makePlot("plot-1"), oversize, makePlot("plot-3")];
    expect(
      selectPlotsForStorage(
        [plotItem("plot-1"), plotItem("plot-2"), plotItem("plot-3")],
        plots,
      ),
    ).toEqual([plots[0], plots[2]]);
  });
});

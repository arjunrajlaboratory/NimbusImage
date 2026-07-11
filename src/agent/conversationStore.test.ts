import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach } from "vitest";
import {
  loadStoredConversation,
  saveStoredConversation,
  clearStoredConversation,
} from "./conversationStore";

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

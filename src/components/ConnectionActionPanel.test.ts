import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { shallowMount } from "@vue/test-utils";

const h = vi.hoisted(() => ({
  deleteSelectedConnections: vi.fn(),
  setSelectedConnectionIds: vi.fn(),
  selectedExistingConnectionIds: ["c1"] as string[],
  isLoggedIn: true,
}));

vi.mock("@/store", () => ({
  default: {
    get isLoggedIn() {
      return h.isLoggedIn;
    },
  },
}));

vi.mock("@/store/connectionList", () => ({
  default: {
    get selectedExistingConnectionIds() {
      return h.selectedExistingConnectionIds;
    },
    deleteSelectedConnections: h.deleteSelectedConnections,
    setSelectedConnectionIds: h.setSelectedConnectionIds,
  },
}));

import ConnectionActionPanel from "./ConnectionActionPanel.vue";

// The panel binds a window keydown listener, so a wrapper left mounted by one
// test would keep firing in the next.
let wrapper: ReturnType<typeof shallowMount> | null = null;

function mountPanel() {
  wrapper = shallowMount(ConnectionActionPanel, { props: { stacked: false } });
  return wrapper;
}

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

function press(key: string, mods: Partial<KeyboardEventInit> = {}) {
  window.dispatchEvent(new KeyboardEvent("keydown", { key, ...mods }));
}

beforeEach(() => {
  vi.clearAllMocks();
  h.isLoggedIn = true;
  h.selectedExistingConnectionIds = ["c1"];
});

describe("ConnectionActionPanel", () => {
  it("counts only connections that still exist", () => {
    h.selectedExistingConnectionIds = ["c1", "c2"];
    expect((mountPanel().vm as any).selectedCount).toBe(2);
  });

  it("deletes on a bare Delete or Backspace", async () => {
    const panel = mountPanel();
    press("Delete");
    expect(h.deleteSelectedConnections).toHaveBeenCalledTimes(1);
    await (panel.vm as any).$nextTick();
  });

  // Regression: mod+backspace is already bound to "delete selected objects",
  // and clicking a connection row selects both endpoint objects AND the
  // connection — so matching the modified combo would fire two destructive
  // operations from one keystroke.
  it("ignores the modified object-delete shortcut", () => {
    mountPanel();
    press("Backspace", { metaKey: true });
    press("Backspace", { ctrlKey: true });
    press("Backspace", { altKey: true });
    expect(h.deleteSelectedConnections).not.toHaveBeenCalled();
  });

  it("ignores the key while typing in a field", () => {
    mountPanel();
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Delete", bubbles: true }),
    );
    expect(h.deleteSelectedConnections).not.toHaveBeenCalled();
    input.remove();
  });

  it("stops listening once unmounted", () => {
    mountPanel().unmount();
    wrapper = null;
    press("Delete");
    expect(h.deleteSelectedConnections).not.toHaveBeenCalled();
  });
});

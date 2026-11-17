import { describe, it, expect, vi, afterEach } from "vitest";
import { boundKeys, mousetrapDirective, setHotkeysPaused } from "./v-mousetrap";

// Real Mousetrap (not mocked): the behaviour under test is its stopCallback,
// which ignores keys typed into text fields.

const mounted: HTMLElement[] = [];
afterEach(() => {
  mounted.splice(0).forEach((el) => mousetrapDirective.unmounted(el));
  document.body.innerHTML = "";
});

function bindHotkeys(value: any[]) {
  const el = document.createElement("div");
  mousetrapDirective.mounted(el, { value, modifiers: {} });
  mounted.push(el);
}

function keydownIn(target: Element, key: string, init: KeyboardEventInit) {
  target.dispatchEvent(
    new KeyboardEvent("keydown", {
      key,
      keyCode: key.toUpperCase().charCodeAt(0),
      which: key.toUpperCase().charCodeAt(0),
      bubbles: true,
      ...init,
    } as KeyboardEventInit),
  );
}

describe("v-mousetrap allowInInputs", () => {
  it("fires an allowInInputs hotkey from inside a text field, and only that one", () => {
    const palette = vi.fn();
    const plain = vi.fn();
    bindHotkeys([
      { bind: "ctrl+k", handler: palette, allowInInputs: true },
      { bind: "ctrl+j", handler: plain },
    ]);
    const input = document.createElement("input");
    document.body.appendChild(input);

    keydownIn(input, "k", { ctrlKey: true });
    keydownIn(input, "j", { ctrlKey: true });
    expect(palette).toHaveBeenCalledTimes(1);
    expect(plain).not.toHaveBeenCalled();

    // Outside a text field both fire, as before.
    keydownIn(document.body, "j", { ctrlKey: true });
    expect(plain).toHaveBeenCalledTimes(1);
  });
});

describe("v-mousetrap setHotkeysPaused", () => {
  afterEach(() => setHotkeysPaused(false));

  // Mousetrap matches plain letters on keypress.
  function pressG() {
    document.body.dispatchEvent(
      new KeyboardEvent("keypress", {
        key: "g",
        charCode: 103,
        keyCode: 103,
        which: 103,
        bubbles: true,
      } as KeyboardEventInit),
    );
  }

  it("runs no bound handler while paused", () => {
    const handler = vi.fn();
    bindHotkeys([{ bind: "g", handler }]);
    setHotkeysPaused(true);
    pressG();
    expect(handler).not.toHaveBeenCalled();
    setHotkeysPaused(false);
    pressG();
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe("v-mousetrap boundKeys", () => {
  const tool = { section: "Tools", description: "Toggle tool:  Cells" };
  const transcripts = { section: "View", description: "Show/hide transcripts" };

  function bindOn(el: Element, value: any[]) {
    mousetrapDirective.mounted(el, { value, modifiers: {} });
  }

  it("lists every binding on a shared key and keeps the others on unbind", () => {
    const toolEl = document.createElement("div");
    const transcriptsEl = document.createElement("div");
    bindOn(toolEl, [{ bind: "g", handler: vi.fn(), data: tool }]);
    bindOn(transcriptsEl, [{ bind: "g", handler: vi.fn(), data: transcripts }]);
    expect(boundKeys.value.g).toEqual([tool, transcripts]);

    mousetrapDirective.unmounted(toolEl);
    expect(boundKeys.value.g).toEqual([transcripts]);

    mousetrapDirective.unmounted(transcriptsEl);
    expect(boundKeys.value.g).toBeUndefined();
  });

  it("does not list a disabled binding", () => {
    const el = document.createElement("div");
    bindOn(el, [
      { bind: "g", handler: vi.fn(), data: transcripts, disabled: true },
    ]);
    expect(boundKeys.value.g).toBeUndefined();
    mousetrapDirective.unmounted(el);
    expect(boundKeys.value.g).toBeUndefined();
  });
});

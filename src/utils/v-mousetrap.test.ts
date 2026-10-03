import { describe, it, expect, vi, afterEach } from "vitest";
import { mousetrapDirective } from "./v-mousetrap";

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

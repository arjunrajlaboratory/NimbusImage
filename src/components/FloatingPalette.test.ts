import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import FloatingPalette from "./FloatingPalette.vue";

function mountPalette(props: Record<string, unknown> = {}) {
  return mount(FloatingPalette, {
    props: { modelValue: true, title: "Layers", width: 400, ...props },
    attachTo: document.body,
  });
}

// jsdom has no PointerEvent; a MouseEvent of the same type reaches the same
// listeners, with pointerId added.
function pointer(
  type: string,
  init: { clientX?: number; clientY?: number; pointerId?: number } = {},
) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    clientX: init.clientX ?? 0,
    clientY: init.clientY ?? 0,
  });
  Object.defineProperty(event, "pointerId", { value: init.pointerId ?? 1 });
  return event;
}

function fire(
  wrapper: ReturnType<typeof mountPalette>,
  selector: string,
  type: string,
  init?: Parameters<typeof pointer>[1],
) {
  wrapper.find(selector).element.dispatchEvent(pointer(type, init));
}

// The root is a <transition>, which the test utils stub with a wrapper element.
function palette(wrapper: ReturnType<typeof mountPalette>): HTMLElement {
  return wrapper.find(".floating-palette").element as HTMLElement;
}

const HANDLE = ".palette-resize-handle";
const GRIP = ".palette-grip";

describe("FloatingPalette", () => {
  it("has one way to close: the X, which closes it", async () => {
    const wrapper = mountPalette();
    expect(wrapper.findAll(".palette-actions button")).toHaveLength(1);
    await wrapper.find('[aria-label="Close palette"]').trigger("click");
    expect(wrapper.emitted("update:modelValue")).toEqual([[false]]);
  });

  it("names the tour step it completes when given an anchor", () => {
    expect(
      palette(mountPalette({ tourDoneAnchor: "object-list-button" })).dataset
        .tourDone,
    ).toBe("object-list-button");
    expect(palette(mountPalette()).dataset.tourDone).toBeUndefined();
  });

  it("has no resize handle unless an edge is given", () => {
    expect(mountPalette().find(HANDLE).exists()).toBe(false);
  });

  describe("resizing", () => {
    function mountResizable(resizeEdge: "left" | "right") {
      const wrapper = mountPalette({ resizeEdge });
      // jsdom lays nothing out; the drag starts from the rendered width.
      Object.defineProperty(palette(wrapper), "offsetWidth", { value: 400 });
      return wrapper;
    }

    it("a right-edge handle widens as it is dragged right", () => {
      const wrapper = mountResizable("right");
      fire(wrapper, HANDLE, "pointerdown", { clientX: 500 });
      fire(wrapper, HANDLE, "pointermove", { clientX: 560 });
      fire(wrapper, HANDLE, "pointerup", { clientX: 580 });
      expect(wrapper.emitted("resize")).toEqual([[460]]);
      expect(wrapper.emitted("resize-end")).toEqual([[480]]);
    });

    it("a left-edge handle widens as it is dragged left", () => {
      const wrapper = mountResizable("left");
      fire(wrapper, HANDLE, "pointerdown", { clientX: 500 });
      fire(wrapper, HANDLE, "pointermove", { clientX: 440 });
      fire(wrapper, HANDLE, "pointerup", { clientX: 440 });
      expect(wrapper.emitted("resize")).toEqual([[460]]);
      expect(wrapper.emitted("resize-end")).toEqual([[460]]);
    });

    it("ends once: the lost capture that follows pointerup does nothing", () => {
      const wrapper = mountResizable("right");
      fire(wrapper, HANDLE, "pointerdown", { clientX: 500 });
      fire(wrapper, HANDLE, "pointermove", { clientX: 510 });
      fire(wrapper, HANDLE, "pointerup", { clientX: 520 });
      fire(wrapper, HANDLE, "lostpointercapture");
      expect(wrapper.emitted("resize-end")).toHaveLength(1);
      expect(wrapper.emitted("resize-cancel")).toBeUndefined();
    });

    it.each(["pointercancel", "lostpointercapture"])(
      "%s cancels the drag, and later moves are ignored",
      (type) => {
        const wrapper = mountResizable("right");
        fire(wrapper, HANDLE, "pointerdown", { clientX: 500 });
        fire(wrapper, HANDLE, "pointermove", { clientX: 520 });
        fire(wrapper, HANDLE, type);
        fire(wrapper, HANDLE, "pointermove", { clientX: 700 });
        fire(wrapper, HANDLE, "pointerup", { clientX: 700 });
        expect(wrapper.emitted("resize-cancel")).toHaveLength(1);
        expect(wrapper.emitted("resize")).toEqual([[420]]);
        expect(wrapper.emitted("resize-end")).toBeUndefined();
      },
    );

    it("Escape cancels the drag and is not passed on", () => {
      const wrapper = mountResizable("right");
      fire(wrapper, HANDLE, "pointerdown", { clientX: 500 });
      fire(wrapper, HANDLE, "pointermove", { clientX: 520 });
      const escape = new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
      });
      let reached = false;
      const listener = () => {
        reached = true;
      };
      document.body.addEventListener("keydown", listener);
      document.body.dispatchEvent(escape);
      document.body.removeEventListener("keydown", listener);
      expect(wrapper.emitted("resize-cancel")).toHaveLength(1);
      expect(reached).toBe(false);
      fire(wrapper, HANDLE, "pointerup", { clientX: 700 });
      expect(wrapper.emitted("resize-end")).toBeUndefined();
    });

    it("Escape with no drag in progress is left alone", () => {
      mountResizable("right");
      let reached = false;
      const listener = () => {
        reached = true;
      };
      document.body.addEventListener("keydown", listener);
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
      document.body.removeEventListener("keydown", listener);
      expect(reached).toBe(true);
    });

    it("unmounting mid-drag cancels it", () => {
      const wrapper = mountResizable("right");
      fire(wrapper, HANDLE, "pointerdown", { clientX: 500 });
      fire(wrapper, HANDLE, "pointermove", { clientX: 520 });
      wrapper.unmount();
      expect(wrapper.emitted("resize-cancel")).toHaveLength(1);
    });

    it("a click on the handle, or a press that barely moves, changes nothing", () => {
      const wrapper = mountResizable("right");
      fire(wrapper, HANDLE, "pointerdown", { clientX: 500 });
      fire(wrapper, HANDLE, "pointerup", { clientX: 500 });
      fire(wrapper, HANDLE, "pointerdown", { clientX: 500 });
      fire(wrapper, HANDLE, "pointermove", { clientX: 502 });
      fire(wrapper, HANDLE, "pointerup", { clientX: 502 });
      fire(wrapper, HANDLE, "pointerdown", { clientX: 500 });
      fire(wrapper, HANDLE, "pointercancel");
      expect(wrapper.emitted("resize")).toBeUndefined();
      expect(wrapper.emitted("resize-end")).toBeUndefined();
      expect(wrapper.emitted("resize-cancel")).toBeUndefined();
    });

    it("keeps the body, and its scrollbar, out from under the handle", () => {
      expect(mountResizable("right").find(".resizes-right").exists()).toBe(
        true,
      );
      expect(mountPalette().find('[class*="resizes-"]').exists()).toBe(false);
    });

    it("ignores another pointer and a non-primary button", () => {
      const wrapper = mountResizable("right");
      const rightButton = new MouseEvent("pointerdown", {
        bubbles: true,
        button: 2,
      });
      wrapper.find(HANDLE).element.dispatchEvent(rightButton);
      fire(wrapper, HANDLE, "pointermove", { clientX: 700 });
      expect(wrapper.emitted("resize")).toBeUndefined();

      fire(wrapper, HANDLE, "pointerdown", { clientX: 500, pointerId: 1 });
      fire(wrapper, HANDLE, "pointermove", { clientX: 700, pointerId: 2 });
      fire(wrapper, HANDLE, "pointerup", { clientX: 700, pointerId: 2 });
      expect(wrapper.emitted("resize")).toBeUndefined();
      expect(wrapper.emitted("resize-end")).toBeUndefined();
    });

    it("double-click asks for the default width", async () => {
      const wrapper = mountResizable("right");
      await wrapper.find(HANDLE).trigger("dblclick");
      expect(wrapper.emitted("resize-reset")).toHaveLength(1);
    });
  });

  describe("from the keyboard", () => {
    function key(
      wrapper: ReturnType<typeof mountPalette>,
      selector: string,
      init: KeyboardEventInit,
    ) {
      const event = new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        ...init,
      });
      let reached = false;
      const listener = () => {
        reached = true;
      };
      document.body.addEventListener("keydown", listener);
      wrapper.find(selector).element.dispatchEvent(event);
      document.body.removeEventListener("keydown", listener);
      return { reached, prevented: event.defaultPrevented };
    }

    function mountResizable(resizeEdge: "left" | "right") {
      const wrapper = mountPalette({ resizeEdge });
      Object.defineProperty(palette(wrapper), "offsetWidth", { value: 400 });
      return wrapper;
    }

    it("the handle can be focused and says how wide the palette is and can be", () => {
      const handle = mountResizable("right").find(HANDLE);
      expect(handle.attributes("tabindex")).toBe("0");
      expect(handle.attributes("aria-valuenow")).toBe("400");
      const ranged = mountPalette({
        resizeEdge: "right",
        resizeRange: { base: 420, min: 380, max: 648 },
      }).find(HANDLE);
      expect(ranged.attributes("aria-valuemin")).toBe("380");
      expect(ranged.attributes("aria-valuemax")).toBe("648");
    });

    it("a resize starts from the zone's width, not this palette's", () => {
      // A 400px palette in a zone whose widest palette is 420.
      const wrapper = mountPalette({
        resizeEdge: "right",
        resizeRange: { base: 420, min: 380, max: 648 },
      });
      Object.defineProperty(palette(wrapper), "offsetWidth", { value: 400 });
      key(wrapper, HANDLE, { key: "ArrowRight" });
      fire(wrapper, HANDLE, "pointerdown", { clientX: 500 });
      fire(wrapper, HANDLE, "pointermove", { clientX: 510 });
      fire(wrapper, HANDLE, "pointerup", { clientX: 510 });
      // Never below the 420 the wider palette already has.
      expect(wrapper.emitted("resize-end")).toEqual([[436], [430]]);
    });

    it("arrows resize toward and away from the canvas, more with Shift", () => {
      const left = mountResizable("right"); // a left palette: canvas is right
      key(left, HANDLE, { key: "ArrowRight" });
      key(left, HANDLE, { key: "ArrowLeft" });
      key(left, HANDLE, { key: "ArrowRight", shiftKey: true });
      expect(left.emitted("resize-end")).toEqual([[416], [384], [464]]);

      const right = mountResizable("left"); // a right palette: canvas is left
      key(right, HANDLE, { key: "ArrowLeft" });
      key(right, HANDLE, { key: "ArrowRight" });
      expect(right.emitted("resize-end")).toEqual([[416], [384]]);
    });

    it("Enter on the handle asks for the default width", () => {
      const wrapper = mountResizable("right");
      key(wrapper, HANDLE, { key: "Enter" });
      expect(wrapper.emitted("resize-reset")).toHaveLength(1);
    });

    it("keeps the keys it uses from the viewer's hotkeys, and passes on the rest", () => {
      const wrapper = mountPalette({ resizeEdge: "right", reorderable: true });
      expect(key(wrapper, HANDLE, { key: "ArrowLeft" })).toEqual({
        reached: false,
        prevented: true,
      });
      expect(key(wrapper, GRIP, { key: "ArrowDown" })).toEqual({
        reached: false,
        prevented: true,
      });
      expect(key(wrapper, HANDLE, { key: "ArrowUp" }).reached).toBe(true);
      expect(key(wrapper, GRIP, { key: "ArrowLeft" }).reached).toBe(true);
      expect(key(wrapper, GRIP, { key: "Tab" }).prevented).toBe(false);
    });

    it("up and down on the grip move the palette one place", () => {
      const wrapper = mountPalette({ reorderable: true });
      const grip = wrapper.find(GRIP);
      expect(grip.attributes("tabindex")).toBe("0");
      // A slider over its place in the stack: that is what the arrows change.
      expect(grip.attributes("role")).toBe("slider");
      expect(grip.attributes("aria-hidden")).toBeUndefined();
      expect(grip.attributes("aria-label")).toContain("Position of Layers");
      const placed = mountPalette({
        reorderable: true,
        stackPosition: { position: 2, count: 3 },
      }).find(GRIP);
      expect(placed.attributes("aria-valuenow")).toBe("2");
      expect(placed.attributes("aria-valuemax")).toBe("3");
      expect(placed.attributes("aria-valuetext")).toBe("2 of 3");
      key(wrapper, GRIP, { key: "ArrowUp" });
      key(wrapper, GRIP, { key: "ArrowDown" });
      expect(wrapper.emitted("reorder-step")).toEqual([[-1], [1]]);
    });

    it("a grip that cannot reorder stays decoration", () => {
      const wrapper = mountPalette();
      const grip = wrapper.find(GRIP);
      expect(grip.attributes("aria-hidden")).toBe("true");
      expect(grip.attributes("tabindex")).toBeUndefined();
      key(wrapper, GRIP, { key: "ArrowDown" });
      expect(wrapper.emitted("reorder-step")).toBeUndefined();
    });
  });

  describe("reordering", () => {
    it("carries the palette with the drag and reports where it was dropped", async () => {
      const wrapper = mountPalette({ reorderable: true });
      fire(wrapper, GRIP, "pointerdown", { clientY: 100 });
      fire(wrapper, GRIP, "pointermove", { clientY: 180 });
      await wrapper.vm.$nextTick();
      expect(palette(wrapper).style.transform).toBe("translateY(80px)");
      fire(wrapper, GRIP, "pointerup", { clientY: 240 });
      await wrapper.vm.$nextTick();
      expect(wrapper.emitted("reorder-end")).toEqual([[140]]);
      expect(palette(wrapper).style.transform).toBe("");
    });

    it("a cancelled drag puts the palette back and reports nothing", async () => {
      const wrapper = mountPalette({ reorderable: true });
      fire(wrapper, GRIP, "pointerdown", { clientY: 100 });
      fire(wrapper, GRIP, "pointermove", { clientY: 180 });
      fire(wrapper, GRIP, "pointercancel");
      await wrapper.vm.$nextTick();
      expect(wrapper.emitted("reorder-end")).toBeUndefined();
      expect(palette(wrapper).style.transform).toBe("");
    });

    it("a click on the grip does not reorder", () => {
      const wrapper = mountPalette({ reorderable: true });
      fire(wrapper, GRIP, "pointerdown", { clientY: 100 });
      fire(wrapper, GRIP, "pointerup", { clientY: 101 });
      expect(wrapper.emitted("reorder-end")).toBeUndefined();
    });

    it("names its panel in the DOM when given an id", () => {
      expect(
        palette(mountPalette({ panelId: "toolsPanel" })).dataset.panelId,
      ).toBe("toolsPanel");
      expect(palette(mountPalette()).dataset.panelId).toBeUndefined();
    });

    it("the grip does nothing on a palette that cannot be reordered", () => {
      const wrapper = mountPalette();
      fire(wrapper, GRIP, "pointerdown", { clientY: 100 });
      fire(wrapper, GRIP, "pointerup", { clientY: 300 });
      expect(wrapper.emitted("reorder-end")).toBeUndefined();
    });
  });
});

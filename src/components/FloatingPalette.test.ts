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
  it("shows the minimize button only when minimizable, and emits minimize", async () => {
    expect(
      mountPalette().find('[aria-label="Minimize palette"]').exists(),
    ).toBe(false);
    const wrapper = mountPalette({ minimizable: true });
    await wrapper.find('[aria-label="Minimize palette"]').trigger("click");
    expect(wrapper.emitted("minimize")).toHaveLength(1);
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

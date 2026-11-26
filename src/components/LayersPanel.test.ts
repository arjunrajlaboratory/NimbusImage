import { describe, it, expect, vi } from "vitest";
import { defineComponent, h } from "vue";
import { shallowMount } from "@vue/test-utils";

vi.mock("@/store", () => ({
  default: {
    layerMode: "multiple",
    isLoggedIn: true,
    setLayerMode: vi.fn(),
    addLayer: vi.fn(),
  },
}));

import LayersPanel from "./LayersPanel.vue";
import { usePanelVisible } from "@/utils/panelVisibility";

// Stands in for the layer rows: reports what they would be told.
const VisibilityProbe = defineComponent({
  name: "DisplayLayers",
  setup() {
    const visible = usePanelVisible();
    return () => h("i", { "data-visible": String(visible.value) });
  },
});

function mountPanel(props: Record<string, unknown> = {}) {
  return shallowMount(LayersPanel, {
    props,
    global: { stubs: { DisplayLayers: VisibilityProbe } },
  });
}

describe("LayersPanel", () => {
  it("tells the rows inside it whether the palette is on screen", async () => {
    const wrapper = mountPanel({ visible: false });
    expect(wrapper.find("i").attributes("data-visible")).toBe("false");
    await wrapper.setProps({ visible: true });
    expect(wrapper.find("i").attributes("data-visible")).toBe("true");
  });

  it("counts as on screen when mounted without a palette", () => {
    expect(mountPanel().find("i").attributes("data-visible")).toBe("true");
  });
});

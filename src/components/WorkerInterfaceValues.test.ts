import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";

vi.mock("@/store", () => ({
  default: {
    layers: [],
  },
}));

vi.mock("@/store/annotation", () => ({
  default: {
    annotationTags: [],
  },
}));

import WorkerInterfaceValues from "./WorkerInterfaceValues.vue";

const sampleInterface = {
  threshold: {
    type: "number" as const,
    min: 0,
    max: 100,
    default: 50,
    displayOrder: 1,
  },
  name: {
    type: "text" as const,
    default: "test",
    displayOrder: undefined,
  },
  alpha: {
    type: "number" as const,
    min: 0,
    max: 1,
    default: 0.5,
    displayOrder: 0,
  },
};

function mountComponent(props = {}) {
  return mount(WorkerInterfaceValues, {
    props: {
      modelValue: {},
      workerInterface: sampleInterface,
      ...props,
    },
    global: {
      stubs: {
        "layer-select": { template: "<div></div>", props: ["modelValue"] },
        "channel-select": { template: "<div></div>", props: ["modelValue"] },
        "channel-checkbox-group": {
          template: "<div></div>",
          props: ["modelValue"],
        },
        "tag-picker": { template: "<div></div>", props: ["modelValue"] },
      },
    },
    directives: {
      tooltip: {},
    },
  });
}

describe("WorkerInterfaceValues", () => {
  it("orderItemEntries sorts by displayOrder (explicit first, then alphabetical)", () => {
    const wrapper = mountComponent();
    const entries = (wrapper.vm as any).orderItemEntries;
    // alpha (0), threshold (1) are explicit; name (undefined) is alphabetical
    expect(entries[0][0]).toBe("alpha");
    expect(entries[1][0]).toBe("threshold");
    expect(entries[2][0]).toBe("name");
  });

  it("formattedTooltip replaces newlines with <br>", () => {
    const wrapper = mountComponent();
    expect((wrapper.vm as any).formattedTooltip("line1\nline2")).toBe(
      "line1<br>line2",
    );
  });

  it("renders with provided modelValue without emitting initialization", () => {
    const modelValue = { threshold: 75, alpha: 0.2, name: "custom" };
    const wrapper = mountComponent({ modelValue });
    // Should not emit update:modelValue — parent owns initialization
    const emitted = wrapper.emitted("update:modelValue");
    expect(emitted).toBeFalsy();
  });

  it("isLeft and isRight derive from tooltipPosition prop", () => {
    const wrapper = mountComponent({ tooltipPosition: "left" });
    expect((wrapper.vm as any).isLeft).toBe(true);
    expect((wrapper.vm as any).isRight).toBe(false);
  });

  it("defaults tooltipPosition to right", () => {
    const wrapper = mountComponent();
    expect((wrapper.vm as any).isRight).toBe(true);
    expect((wrapper.vm as any).isLeft).toBe(false);
  });
});

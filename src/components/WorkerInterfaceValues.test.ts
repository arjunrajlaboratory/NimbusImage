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

  it("populateValues uses tool values when available", () => {
    const tool = {
      values: {
        workerInterfaceValues: {
          threshold: 75,
          alpha: 0.2,
        },
      },
    };
    const wrapper = mountComponent({ tool });
    const emitted = wrapper.emitted("update:modelValue");
    expect(emitted).toBeTruthy();
    const lastValues = emitted![emitted!.length - 1][0] as any;
    expect(lastValues.threshold).toBe(75);
    expect(lastValues.alpha).toBe(0.2);
  });

  it("populateValues falls back to getDefault when no tool", () => {
    const wrapper = mountComponent({ tool: null });
    const emitted = wrapper.emitted("update:modelValue");
    expect(emitted).toBeTruthy();
    const lastValues = emitted![emitted!.length - 1][0] as any;
    expect(lastValues.threshold).toBe(50); // default from interface
    expect(lastValues.name).toBe("test"); // default from interface
    expect(lastValues.alpha).toBe(0.5);
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

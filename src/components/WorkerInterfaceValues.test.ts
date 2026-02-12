import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";

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

Vue.use(Vuetify);

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
    vuetify: new Vuetify(),
    propsData: {
      value: {},
      workerInterface: sampleInterface,
      ...props,
    },
    stubs: {
      "layer-select": { template: "<div></div>", props: ["value"] },
      "channel-select": { template: "<div></div>", props: ["value"] },
      "channel-checkbox-group": { template: "<div></div>", props: ["value"] },
      "tag-picker": { template: "<div></div>", props: ["value"] },
    },
    directives: {
      tooltip: {},
    },
  });
}

describe("WorkerInterfaceValues", () => {
  it("orderItemEntries sorts by displayOrder (explicit first, then alphabetical)", () => {
    const wrapper = mountComponent();
    const entries = wrapper.vm.orderItemEntries;
    // alpha (0), threshold (1) are explicit; name (undefined) is alphabetical
    expect(entries[0][0]).toBe("alpha");
    expect(entries[1][0]).toBe("threshold");
    expect(entries[2][0]).toBe("name");
  });

  it("formattedTooltip replaces newlines with <br>", () => {
    const wrapper = mountComponent();
    expect(wrapper.vm.formattedTooltip("line1\nline2")).toBe("line1<br>line2");
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
    const emitted = wrapper.emitted("input");
    expect(emitted).toBeTruthy();
    const lastValues = emitted![emitted!.length - 1][0];
    expect(lastValues.threshold).toBe(75);
    expect(lastValues.alpha).toBe(0.2);
  });

  it("populateValues falls back to getDefault when no tool", () => {
    const wrapper = mountComponent({ tool: null });
    const emitted = wrapper.emitted("input");
    expect(emitted).toBeTruthy();
    const lastValues = emitted![emitted!.length - 1][0];
    expect(lastValues.threshold).toBe(50); // default from interface
    expect(lastValues.name).toBe("test"); // default from interface
    expect(lastValues.alpha).toBe(0.5);
  });

  it("isLeft and isRight derive from tooltipPosition prop", () => {
    const wrapper = mountComponent({ tooltipPosition: "left" });
    expect(wrapper.vm.isLeft).toBe(true);
    expect(wrapper.vm.isRight).toBe(false);
  });

  it("defaults tooltipPosition to right", () => {
    const wrapper = mountComponent();
    expect(wrapper.vm.isRight).toBe(true);
    expect(wrapper.vm.isLeft).toBe(false);
  });
});

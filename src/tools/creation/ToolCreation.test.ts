import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";

vi.mock("uuid", () => ({
  v4: vi.fn(() => "test-uuid-1234"),
}));

vi.mock("@/store", () => ({
  default: {
    addToolToConfiguration: vi.fn(),
  },
}));

vi.mock("@/store/properties", () => ({
  default: {
    defaultToolName: vi.fn(),
  },
}));

vi.mock("@/store/annotation", () => ({
  default: {},
}));

vi.mock("@/tools/creation/ToolConfiguration.vue", () => ({
  default: {
    name: "ToolConfiguration",
    template: "<div />",
    props: ["template", "defaultValues", "value"],
    methods: { reset: vi.fn() },
  },
}));

vi.mock("@/tools/creation/ToolTypeSelection.vue", () => ({
  default: {
    name: "ToolTypeSelection",
    template: "<div />",
  },
  TReturnType: {},
}));

vi.mock("@/components/HotkeySelection.vue", () => ({
  default: {
    name: "HotkeySelection",
    template: "<div />",
    props: ["value"],
  },
}));

import store from "@/store";
import propertiesStore from "@/store/properties";
import ToolCreation from "./ToolCreation.vue";

Vue.use(Vuetify);
Vue.directive("tour-trigger", {});

function mountComponent(propsData = {}) {
  return mount(ToolCreation, {
    vuetify: new Vuetify(),
    propsData: {
      open: false,
      ...propsData,
    },
  });
}

describe("ToolCreation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("createTool builds config and calls store.addToolToConfiguration", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;

    // Set up the template to allow creation
    vm.selectedTemplate = {
      name: "Point",
      type: "create",
      description: "Create a point",
      interface: [],
    };
    vm.toolName = "My Test Tool";
    vm.toolValues = { annotation: { shape: "point" } };
    vm.hotkey = "p";

    vm.createTool();

    expect(store.addToolToConfiguration).toHaveBeenCalledWith({
      id: "test-uuid-1234",
      name: "My Test Tool",
      template: {
        name: "Point",
        type: "create",
        description: "Create a point",
        interface: [],
      },
      values: { annotation: { shape: "point" } },
      type: "create",
      hotkey: "p",
    });
  });

  it("createTool does nothing when selectedTemplate is null", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;

    vm.selectedTemplate = null;
    vm.createTool();

    expect(store.addToolToConfiguration).not.toHaveBeenCalled();
  });

  it("createTool uses 'Unnamed Tool' when toolName is empty", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;

    vm.selectedTemplate = {
      name: "Point",
      type: "create",
      description: "",
      interface: [],
    };
    vm.toolName = "";

    vm.createTool();

    expect(store.addToolToConfiguration).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Unnamed Tool" }),
    );
  });

  it("close emits done", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;

    vm.close();

    expect(wrapper.emitted("done")).toHaveLength(1);
  });

  it("close calls reset before emitting done", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;

    // Set some state
    vm.selectedTemplate = {
      name: "Test",
      type: "create",
      description: "",
      interface: [],
    };
    vm.toolName = "Custom Name";
    vm.userToolName = true;
    vm.hotkey = "x";

    vm.close();

    // State should be reset
    expect(vm.selectedTemplate).toBeNull();
    expect(vm.toolName).toBe("New Tool");
    expect(vm.userToolName).toBe(false);
    expect(vm.hotkey).toBeNull();
    expect(wrapper.emitted("done")).toHaveLength(1);
  });

  it("reset clears state", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;

    // Set state
    vm.userToolName = true;
    vm.toolName = "Modified Name";
    vm.selectedTemplate = { name: "Test", type: "create" };
    vm.selectedDefaultValues = { foo: "bar" };
    vm.hotkey = "h";

    vm.reset();

    expect(vm.userToolName).toBe(false);
    expect(vm.toolName).toBe("New Tool");
    expect(vm.selectedTemplate).toBeNull();
    expect(vm.selectedDefaultValues).toBeNull();
    expect(vm.hotkey).toBeNull();
  });

  it("auto-naming generates name from template name when no detailed values", async () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;

    vm.userToolName = false;
    vm.selectedTemplate = {
      name: "Blob Tool",
      type: "create",
      description: "",
      interface: [],
    };
    vm.toolValues = {};

    vm.updateAutoToolName();

    expect(vm.toolName).toBe("Blob Tool");
  });

  it("auto-naming skips when userToolName is true", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;

    vm.userToolName = true;
    vm.toolName = "My Custom Name";
    vm.selectedTemplate = {
      name: "Blob Tool",
      type: "create",
      description: "",
      interface: [],
    };

    vm.updateAutoToolName();

    // Should not change
    expect(vm.toolName).toBe("My Custom Name");
  });

  it("auto-naming uses annotation tags from toolValues", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;

    vm.userToolName = false;
    vm.selectedTemplate = {
      name: "Point",
      type: "create",
      description: "",
      interface: [],
    };
    vm.toolValues = { annotation: { tags: ["Cell", "Nucleus"] } };

    vm.updateAutoToolName();

    expect(vm.toolName).toBe("Cell, Nucleus");
  });

  it("auto-naming uses docker image default name from propertiesStore", () => {
    (propertiesStore.defaultToolName as any).mockReturnValue("Docker Worker");

    const wrapper = mountComponent();
    const vm = wrapper.vm as any;

    vm.userToolName = false;
    vm.selectedTemplate = {
      name: "Worker Tool",
      type: "create",
      description: "",
      interface: [],
    };
    vm.toolValues = { image: { image: "my-docker-image:latest" } };

    vm.updateAutoToolName();

    expect(propertiesStore.defaultToolName).toHaveBeenCalledWith(
      "my-docker-image:latest",
    );
    expect(vm.toolName).toBe("Docker Worker");
  });

  it("auto-naming uses model text from toolValues", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;

    vm.userToolName = false;
    vm.selectedTemplate = {
      name: "Test",
      type: "create",
      description: "",
      interface: [],
    };
    vm.toolValues = { model: { text: "ResNet50" } };

    vm.updateAutoToolName();

    expect(vm.toolName).toBe("ResNet50");
  });

  it("auto-naming uses action text from toolValues", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;

    vm.userToolName = false;
    vm.selectedTemplate = {
      name: "Test",
      type: "create",
      description: "",
      interface: [],
    };
    vm.toolValues = { action: { text: "Segment" } };

    vm.updateAutoToolName();

    expect(vm.toolName).toBe("Segment");
  });

  it("auto-naming uses tags for tagging tool type", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;

    vm.userToolName = false;
    vm.selectedTemplate = {
      name: "Tagger",
      type: "tagging",
      description: "",
      interface: [],
    };
    vm.toolValues = { tags: ["TagA", "TagB"] };

    vm.updateAutoToolName();

    expect(vm.toolName).toBe("TagA, TagB");
  });

  it("auto-naming builds parent-to-child connection name", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;

    vm.userToolName = false;
    vm.selectedTemplate = {
      name: "Connect",
      type: "connection",
      description: "",
      interface: [],
    };
    vm.toolValues = {
      parentAnnotation: { tags: ["Parent"], tagsInclusive: true },
      childAnnotation: { tags: ["Child"], tagsInclusive: true },
    };

    vm.updateAutoToolName();

    expect(vm.toolName).toBe("Parent to Child");
  });

  it("auto-naming falls back to 'New Tool' with no data", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;

    vm.userToolName = false;
    vm.selectedTemplate = null;
    vm.toolValues = {};

    vm.updateAutoToolName();

    expect(vm.toolName).toBe("New Tool");
  });

  it("auto-naming uses selectedItem text as fallback", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;

    vm.userToolName = false;
    vm.selectedTemplate = null;
    vm.toolValues = {};

    // Set _selectedTool via selectedTool setter, but since selectedTemplate is
    // null, selectedTool getter returns null. We need to set _selectedTool
    // directly through the internal ref. Instead, let's set selectedTemplate
    // to a value so the getter returns the _selectedTool.
    // Actually: the selectedItem text fallback path only runs when
    // toolNameStrings is empty after the main checks but before the template
    // name check. We need selectedTemplate to be null for the template name
    // push to not happen. But we need _selectedTool.selectedItem.text to exist.
    // The _selectedTool is internal and set via the setter. Let's set it and
    // then clear selectedTemplate.
    vm.selectedTool = {
      template: {
        name: "Dummy",
        type: "create",
        description: "",
        interface: [],
      },
      defaultValues: null,
      selectedItem: { text: "Polygon" },
    };
    // Now clear the template so auto-naming falls through to selectedItem text
    // We need to directly set the internal state. After the setter runs,
    // selectedTemplate got set. Let's reset it.
    vm.selectedTemplate = null;
    vm.toolValues = {};

    vm.updateAutoToolName();

    // _selectedTool still has selectedItem.text = "Polygon"
    // selectedTemplate is null so template.name won't be pushed
    // But _selectedTool.selectedItem.text will be pushed
    expect(vm.toolName).toBe("Polygon");
  });

  it("watch on open triggers reset when closing", async () => {
    const wrapper = mountComponent({ open: true });
    const vm = wrapper.vm as any;

    // Set some state
    vm.toolName = "Custom";
    vm.userToolName = true;

    // Change open to false
    await wrapper.setProps({ open: false });

    expect(vm.toolName).toBe("New Tool");
    expect(vm.userToolName).toBe(false);
  });

  it("watch on initialSelectedTool sets selectedTool", async () => {
    const toolSelection = {
      template: {
        name: "Circle",
        type: "create" as const,
        description: "Draw a circle",
        interface: [],
      },
      defaultValues: { radius: 10 },
      selectedItem: null,
    };

    const wrapper = mountComponent({ initialSelectedTool: toolSelection });
    const vm = wrapper.vm as any;

    expect(vm.selectedTemplate).toEqual(toolSelection.template);
    expect(vm.selectedDefaultValues).toEqual(toolSelection.defaultValues);
  });

  it("connection auto-naming uses 'All' and 'No tag' fallbacks", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;

    vm.userToolName = false;
    vm.selectedTemplate = {
      name: "Connect",
      type: "connection",
      description: "",
      interface: [],
    };
    vm.toolValues = {
      parentAnnotation: { tags: [], tagsInclusive: true },
      childAnnotation: { tags: [], tagsInclusive: false },
    };

    vm.updateAutoToolName();

    expect(vm.toolName).toBe("All to No tag");
  });

  it("createTool calls close after adding tool", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;

    vm.selectedTemplate = {
      name: "Point",
      type: "create",
      description: "",
      interface: [],
    };
    vm.toolName = "My Tool";

    vm.createTool();

    // close() should have been called, which emits "done" and resets state
    expect(wrapper.emitted("done")).toHaveLength(1);
    expect(vm.selectedTemplate).toBeNull();
  });
});

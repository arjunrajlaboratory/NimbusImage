import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";
import Vue from "vue";
import Vuetify from "vuetify";
import RecentProjects from "./RecentProjects.vue";

Vue.use(Vuetify);

const sampleProjects = [
  {
    id: "p1",
    name: "Project Alpha",
    description: "Alpha desc",
    creatorId: "u1",
    created: "2024-01-01T00:00:00Z",
    updated: "2024-06-15T12:00:00Z",
    meta: {
      datasets: [{ datasetId: "d1" }],
      collections: [],
      metadata: {},
      status: "exported",
    },
  },
  {
    id: "p2",
    name: "Project Beta",
    description: "",
    creatorId: "",
    created: "2024-02-01T00:00:00Z",
    updated: "2024-07-01T12:00:00Z",
    meta: {
      datasets: [{ datasetId: "d2" }, { datasetId: "d3" }],
      collections: [],
      metadata: {},
      status: "exporting",
    },
  },
];

function mountComponent(props = {}) {
  return mount(RecentProjects, {
    vuetify: new Vuetify(),
    propsData: {
      projects: sampleProjects,
      loading: false,
      getUserDisplayName: vi.fn((id: string) => `User ${id}`),
      ...props,
    },
  });
}

describe("RecentProjects", () => {
  it("renders project names", () => {
    const wrapper = mountComponent();
    expect(wrapper.text()).toContain("Project Alpha");
    expect(wrapper.text()).toContain("Project Beta");
  });

  it("shows loading state", () => {
    const wrapper = mountComponent({ loading: true });
    expect(wrapper.find(".v-progress-linear").exists()).toBe(true);
  });

  it("shows empty state when no projects", () => {
    const wrapper = mountComponent({ projects: [] });
    expect(wrapper.text()).toContain("No projects yet");
  });

  it("getStatusColor returns correct colors", () => {
    const wrapper = mountComponent();
    expect(wrapper.vm.getStatusColor("exported")).toBe("success");
    expect(wrapper.vm.getStatusColor("exporting")).toBe("warning");
    expect(wrapper.vm.getStatusColor("draft")).toBe("grey");
    expect(wrapper.vm.getStatusColor("unknown")).toBe("grey");
  });

  it("emits project-clicked when a project is clicked", async () => {
    const wrapper = mountComponent();
    const listItems = wrapper.findAll(".v-list-item");
    await listItems.at(0).trigger("click");
    expect(wrapper.emitted("project-clicked")).toBeTruthy();
    expect(wrapper.emitted("project-clicked")![0][0]).toEqual(
      sampleProjects[0],
    );
  });

  it("shows dataset count", () => {
    const wrapper = mountComponent();
    expect(wrapper.text()).toContain("1 dataset");
    expect(wrapper.text()).toContain("2 datasets");
  });
});

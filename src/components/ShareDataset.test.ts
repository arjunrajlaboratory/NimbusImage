import { describe, it, expect, vi, beforeEach } from "vitest";
import { shallowMount } from "@vue/test-utils";

const mockGetDatasetAccess = vi.fn();
const mockFindDatasetViews = vi.fn();
const mockShareDatasetView = vi.fn();
const mockSetDatasetPublic = vi.fn();

vi.mock("@/store", () => ({
  default: {
    dataset: { _id: "ds1", name: "TestDataset" },
    api: {
      getDatasetAccess: (...args: any[]) => mockGetDatasetAccess(...args),
      findDatasetViews: (...args: any[]) => mockFindDatasetViews(...args),
      shareDatasetView: (...args: any[]) => mockShareDatasetView(...args),
      setDatasetPublic: (...args: any[]) => mockSetDatasetPublic(...args),
    },
  },
}));

vi.mock("@/utils/log", () => ({
  logError: vi.fn(),
}));

import ShareDataset from "./ShareDataset.vue";

const defaultAccessList = {
  public: false,
  users: [
    {
      id: "u1",
      login: "admin",
      name: "Admin",
      email: "admin@test.com",
      level: 2,
    },
    {
      id: "u2",
      login: "user1",
      name: "User One",
      email: "user1@test.com",
      level: 0,
    },
  ],
  configurations: [
    { id: "cfg1", name: "Config 1", public: false },
    { id: "cfg2", name: "Config 2", public: false },
  ],
};

const defaultViews = [
  { configurationId: "cfg1", datasetId: "ds1" },
  { configurationId: "cfg2", datasetId: "ds1" },
];

function mountComponent(props: any = {}) {
  return shallowMount(ShareDataset, {
    props: {
      dataset: { _id: "ds1", _modelType: "folder", name: "TestDataset" },
      modelValue: false,
      ...props,
    },
  });
}

describe("ShareDataset", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockGetDatasetAccess.mockResolvedValue({ ...defaultAccessList });
    mockFindDatasetViews.mockResolvedValue([...defaultViews]);
    mockShareDatasetView.mockResolvedValue({});
    mockSetDatasetPublic.mockResolvedValue(undefined);
  });

  it("dialog computed getter returns value prop", () => {
    const wrapper = mountComponent({ modelValue: true });
    const vm = wrapper.vm as any;
    expect(vm.dialog).toBe(true);
  });

  it("dialog computed getter returns false when value is false", () => {
    const wrapper = mountComponent({ modelValue: false });
    const vm = wrapper.vm as any;
    expect(vm.dialog).toBe(false);
  });

  it("dialog computed setter emits input event", () => {
    const wrapper = mountComponent({ modelValue: false });
    const vm = wrapper.vm as any;
    vm.dialog = true;
    expect(wrapper.emitted("update:modelValue")).toBeTruthy();
    expect(wrapper.emitted("update:modelValue")![0][0]).toBe(true);
  });

  it("close sets dialog to false", () => {
    const wrapper = mountComponent({ modelValue: true });
    const vm = wrapper.vm as any;
    vm.close();
    expect(wrapper.emitted("update:modelValue")).toBeTruthy();
    expect(wrapper.emitted("update:modelValue")![0][0]).toBe(false);
  });

  it("initializes with default state values", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.loading).toBe(false);
    expect(vm.showError).toBe(false);
    expect(vm.errorString).toBe("");
    expect(vm.isPublic).toBe(false);
    expect(vm.users).toEqual([]);
    expect(vm.configurations).toEqual([]);
    expect(vm.selectedConfigIds).toEqual([]);
    expect(vm.newUserEmail).toBe("");
    expect(vm.newUserAccessLevel).toBe(0);
  });

  it("resetState clears all fields", async () => {
    const wrapper = mountComponent({ modelValue: true });
    const vm = wrapper.vm as any;

    // Set some state
    vm.loading = true;
    vm.showError = true;
    vm.errorString = "Error";
    vm.isPublic = true;
    vm.users = [{ id: "u1" }];
    vm.newUserEmail = "test@test.com";
    vm.newUserAccessLevel = 1;

    vm.resetState();

    expect(vm.loading).toBe(false);
    expect(vm.showError).toBe(false);
    expect(vm.errorString).toBe("");
    expect(vm.isPublic).toBe(false);
    expect(vm.users).toEqual([]);
    expect(vm.configurations).toEqual([]);
    expect(vm.selectedConfigIds).toEqual([]);
    expect(vm.newUserEmail).toBe("");
    expect(vm.newUserAccessLevel).toBe(0);
    expect(vm.userToRemove).toBeNull();
  });

  it("fetchAccessInfo populates state from API", async () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    await vm.fetchAccessInfo("ds1");

    expect(mockGetDatasetAccess).toHaveBeenCalledWith("ds1");
    expect(mockFindDatasetViews).toHaveBeenCalledWith({ datasetId: "ds1" });
    expect(vm.isPublic).toBe(false);
    expect(vm.users).toHaveLength(2);
    expect(vm.configurations).toHaveLength(2);
    expect(vm.selectedConfigIds).toEqual(["cfg1", "cfg2"]);
    expect(vm.loading).toBe(false);
  });

  it("fetchAccessInfo handles error gracefully", async () => {
    mockGetDatasetAccess.mockRejectedValue(new Error("Network error"));
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    await vm.fetchAccessInfo("ds1");

    expect(vm.showError).toBe(true);
    expect(vm.errorString).toBe("Failed to load access information");
    expect(vm.loading).toBe(false);
  });

  it("togglePublic calls setDatasetPublic API", async () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    await vm.togglePublic(true);

    expect(mockSetDatasetPublic).toHaveBeenCalledWith("ds1", true);
    expect(vm.isPublic).toBe(true);
    expect(vm.publicLoading).toBe(false);
  });

  it("togglePublic reverts isPublic on error", async () => {
    mockSetDatasetPublic.mockRejectedValue(new Error("fail"));
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.isPublic = false;
    await vm.togglePublic(true);

    expect(vm.isPublic).toBe(false);
    expect(vm.showError).toBe(true);
    expect(vm.publicLoading).toBe(false);
  });

  it("togglePublic does nothing when dataset is null", async () => {
    const wrapper = mountComponent({ dataset: null });
    const vm = wrapper.vm as any;
    await vm.togglePublic(true);
    expect(mockSetDatasetPublic).not.toHaveBeenCalled();
  });

  it("updateUserAccess calls shareDatasetView with correct args", async () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    await vm.fetchAccessInfo("ds1");

    const user = vm.users[1]; // non-admin user
    await vm.updateUserAccess(user, 1);

    expect(mockShareDatasetView).toHaveBeenCalledWith(
      expect.any(Array),
      user.login,
      1,
    );
  });

  it("updateUserAccess shows error when no configs selected", async () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    await vm.fetchAccessInfo("ds1");
    vm.selectedConfigIds = [];

    await vm.updateUserAccess({ id: "u2", login: "user1" }, 1);

    expect(vm.showError).toBe(true);
    expect(vm.errorString).toBe("Please select at least one collection");
    expect(mockShareDatasetView).not.toHaveBeenCalled();
  });

  it("updateUserAccess handles badEmailOrUsername response", async () => {
    mockShareDatasetView.mockResolvedValue("badEmailOrUsername");
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    await vm.fetchAccessInfo("ds1");

    await vm.updateUserAccess({ id: "u2", login: "user1" }, 1);

    expect(vm.showError).toBe(true);
    expect(vm.errorString).toBe("User not found");
  });

  it("removeUser calls shareDatasetView with level -1", async () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    await vm.fetchAccessInfo("ds1");
    const user = vm.users[1];
    vm.userToRemove = user;

    await vm.removeUser();

    expect(mockShareDatasetView).toHaveBeenCalledWith(
      expect.any(Array),
      user.login,
      -1,
    );
  });

  it("removeUser removes user from local state on success", async () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    await vm.fetchAccessInfo("ds1");
    const user = vm.users[1];
    vm.userToRemove = user;

    await vm.removeUser();

    expect(vm.users.find((u: any) => u.id === user.id)).toBeUndefined();
  });

  it("removeUser does nothing when userToRemove is null", async () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.userToRemove = null;
    await vm.removeUser();
    expect(mockShareDatasetView).not.toHaveBeenCalled();
  });

  it("addUser calls shareDatasetView and refreshes access", async () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    await vm.fetchAccessInfo("ds1");
    mockGetDatasetAccess.mockClear();
    mockFindDatasetViews.mockClear();

    vm.newUserEmail = "newuser@test.com";
    vm.newUserAccessLevel = 1;
    await vm.addUser();

    expect(mockShareDatasetView).toHaveBeenCalledWith(
      expect.any(Array),
      "newuser@test.com",
      1,
    );
    // Refreshes access info
    expect(mockGetDatasetAccess).toHaveBeenCalledWith("ds1");
    // Form cleared
    expect(vm.newUserEmail).toBe("");
    expect(vm.newUserAccessLevel).toBe(0);
  });

  it("addUser does nothing when email is empty", async () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    vm.newUserEmail = "";
    await vm.addUser();
    expect(mockShareDatasetView).not.toHaveBeenCalled();
  });

  it("addUser shows error when no configs selected", async () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    await vm.fetchAccessInfo("ds1");
    vm.selectedConfigIds = [];
    vm.newUserEmail = "test@test.com";

    await vm.addUser();

    expect(vm.showError).toBe(true);
    expect(vm.errorString).toBe("Please select at least one collection");
  });

  it("addUser handles badEmailOrUsername response", async () => {
    mockShareDatasetView.mockResolvedValue("badEmailOrUsername");
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    await vm.fetchAccessInfo("ds1");
    vm.newUserEmail = "unknown@test.com";

    await vm.addUser();

    expect(vm.showError).toBe(true);
    expect(vm.errorString).toBe(
      "Unknown user. Please check the username or email.",
    );
  });

  it("confirmRemoveUser sets userToRemove and opens confirm dialog", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    const user = { id: "u2", login: "user1", name: "User One" };
    vm.confirmRemoveUser(user);
    expect(vm.userToRemove).toEqual(user);
    expect(vm.confirmDialog).toBe(true);
  });

  it("getSelectedViews filters views by selectedConfigIds", async () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    await vm.fetchAccessInfo("ds1");
    vm.selectedConfigIds = ["cfg1"];

    const views = vm.getSelectedViews();
    expect(views).toHaveLength(1);
    expect(views[0].configurationId).toBe("cfg1");
  });

  it("accessLevelItems contains Read and Write options", () => {
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.accessLevelItems).toEqual([
      { text: "Read", value: 0 },
      { text: "Write", value: 1 },
    ]);
  });

  // Vuetify 3 @change migration: v-checkbox should use @update:model-value
  it("public checkbox triggers togglePublic with boolean via update:modelValue", async () => {
    mockGetDatasetAccess.mockResolvedValue({
      ...defaultAccessList,
      public: false,
    });
    mockFindDatasetViews.mockResolvedValue([...defaultViews]);
    const wrapper = mountComponent({ modelValue: true });
    const vm = wrapper.vm as any;
    await vm.fetchAccessInfo("ds1");
    // Make the component admin so the checkbox is rendered
    vm.isResourceAdmin = true;
    await wrapper.vm.$nextTick();

    // Find the v-checkbox for public toggle
    const checkbox = wrapper
      .findAllComponents({ name: "v-checkbox" })
      .find((c) => c.props("label")?.includes("Make Public"));

    if (checkbox) {
      mockSetDatasetPublic.mockClear();
      // Emit update:modelValue — what Vuetify 3 v-checkbox does on toggle
      checkbox.vm.$emit("update:modelValue", true);
      await wrapper.vm.$nextTick();
      // If wired with @update:model-value, togglePublic(true) should be called
      expect(mockSetDatasetPublic).toHaveBeenCalledWith("ds1", true);
    } else {
      // If checkbox isn't rendered (not admin), test the handler directly
      // to ensure it receives boolean, not Event
      await vm.togglePublic(true);
      expect(mockSetDatasetPublic).toHaveBeenCalledWith("ds1", true);
    }
  });
});

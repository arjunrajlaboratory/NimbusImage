import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";
import StorageUsageSection from "./StorageUsageSection.vue";
import { storageSeverityFromPercentage } from "@/utils/storage";

const mockStore = vi.hoisted(() => ({
  userStorageInfo: null as { used: number; quota: number | null } | null,
  storageUsagePercentage: null as number | null,
  get storageSeverity() {
    return storageSeverityFromPercentage(this.storageUsagePercentage);
  },
}));

vi.mock("@/store", () => ({ default: mockStore }));

const GIGABYTE = 1024 ** 3;

function mountWithStorage(info: { used: number; quota: number | null } | null) {
  mockStore.userStorageInfo = info;
  mockStore.storageUsagePercentage =
    info?.quota != null ? (info.used / info.quota) * 100 : null;
  return mount(StorageUsageSection);
}

describe("StorageUsageSection", () => {
  it("renders nothing when storage info is unavailable", () => {
    const wrapper = mountWithStorage(null);
    expect(wrapper.text()).toBe("");
  });

  it("shows usage without a bar when there is no quota", () => {
    const wrapper = mountWithStorage({ used: 40 * GIGABYTE, quota: null });
    expect(wrapper.text()).toContain("40.00 GB");
    expect(wrapper.text()).toContain("used (no storage limit)");
    expect(wrapper.find(".v-progress-linear").exists()).toBe(false);
  });

  it("shows quota, percentage bar, and no warning below the threshold", () => {
    const wrapper = mountWithStorage({
      used: 50 * GIGABYTE,
      quota: 100 * GIGABYTE,
    });
    expect(wrapper.text()).toContain("of 100.00 GB used");
    expect(wrapper.text()).toContain("50.0% of storage limit used");
    expect(wrapper.find(".v-progress-linear").exists()).toBe(true);
    expect(wrapper.text()).not.toContain("Some operations may not work");
  });

  it("shows the warning once usage escalates past the warning threshold", () => {
    const wrapper = mountWithStorage({
      used: 92 * GIGABYTE,
      quota: 100 * GIGABYTE,
    });
    expect(wrapper.text()).toContain("Some operations may not work");
  });
});

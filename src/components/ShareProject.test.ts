import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  enableAutoUnmount,
  flushPromises,
  shallowMount,
} from "@vue/test-utils";

const mockSetProjectPublic = vi.fn();
const mockGetProjectAccess = vi.fn();
const mockShareProject = vi.fn();

vi.mock("@/store", () => ({
  default: {
    projectsAPI: {
      setProjectPublic: (...args: any[]) => mockSetProjectPublic(...args),
      getProjectAccess: (...args: any[]) => mockGetProjectAccess(...args),
      shareProject: (...args: any[]) => mockShareProject(...args),
    },
  },
}));

vi.mock("@/utils/log", () => ({
  logError: vi.fn(),
}));

import ShareProject from "./ShareProject.vue";

function mountComponent(meta: any = { datasets: [], collections: [] }) {
  return shallowMount(ShareProject, {
    props: {
      project: { id: "p1", name: "Project", meta } as any,
      modelValue: false,
    },
  });
}

enableAutoUnmount(afterEach);

describe("ShareProject", () => {
  beforeEach(() => {
    mockSetProjectPublic.mockReset();
    mockGetProjectAccess.mockReset();
    mockShareProject.mockReset();
  });

  it("reports contained resources set_public left unchanged", async () => {
    mockSetProjectPublic.mockResolvedValue({
      projectId: "p1",
      public: true,
      skipped: 2,
    });
    const vm = mountComponent().vm as any;

    await vm.togglePublic(true);

    expect(vm.isPublic).toBe(true);
    expect(vm.noticeString).toContain("2 datasets, collections or views");
    expect(vm.noticeString).toContain("you don't own");
  });

  it("words the notice for a single skipped resource", async () => {
    mockSetProjectPublic.mockResolvedValue({
      projectId: "p1",
      public: true,
      skipped: 1,
    });
    const vm = mountComponent().vm as any;

    await vm.togglePublic(true);

    expect(vm.noticeString).toContain("1 dataset, collection or view");
    expect(vm.noticeString).toContain("kept its own visibility");
  });

  it("shows no notice when set_public changed everything", async () => {
    mockSetProjectPublic.mockResolvedValue({
      projectId: "p1",
      public: false,
      skipped: 0,
    });
    const vm = mountComponent().vm as any;
    vm.noticeString = "stale notice";

    await vm.togglePublic(false);

    expect(vm.isPublic).toBe(false);
    expect(vm.noticeString).toBe("");
  });

  it("does not claim every project resource is affected", () => {
    const vm = mountComponent({
      datasets: [{ datasetId: "d1" }, { datasetId: "d2" }],
      collections: [{ collectionId: "c1" }],
    }).vm as any;

    expect(vm.impactSummary).toContain("2 datasets and 1 collection");
    expect(vm.impactSummary).toContain("Sharing changes the ones you can edit");
    expect(vm.impactSummary).toContain("refused if it would grant more");
    expect(vm.impactSummary).not.toContain("all associated");
    // Publishing skips configurations of owned datasets the caller only edits
    expect(vm.impactSummary).toContain("publishing changes only what you own");
  });

  it("shows the server's reason when a share is refused", () => {
    const vm = mountComponent().vm as any;
    const refusal = (message: string) => ({
      isAxiosError: true,
      response: { data: { message } },
    });

    expect(
      vm.shareErrorMessage(
        refusal("You cannot grant access above your own level"),
      ),
    ).toBe("You cannot grant access above your own level");
    expect(vm.shareErrorMessage(refusal("badEmailOrUsername"))).toBe(
      "Unknown user. Please check the username or email.",
    );
    expect(vm.shareErrorMessage(new Error("network"))).toBe(
      "An error occurred while updating sharing",
    );
  });
  describe("confirmations and dialog sessions", () => {
    // Resolved or rejected when the test says so.
    function deferred<T = any>() {
      let resolve!: (value: T) => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    }
    const user = (id: string) => ({ id, login: id, name: id, level: 0 }) as any;

    it("runs a second confirmed action opened while the first is running", async () => {
      const first = deferred();
      mockShareProject
        .mockReturnValueOnce(first.promise)
        .mockResolvedValueOnce(undefined);
      const vm = mountComponent().vm as any;
      vm.users = [user("u1"), user("u2")];

      vm.confirmRemoveUser(vm.users[0]);
      const running = vm.executeConfirmedAction();
      vm.confirmRemoveUser(vm.users[1]);
      first.resolve(undefined);
      await running;
      await vm.executeConfirmedAction();

      expect(mockShareProject).toHaveBeenCalledTimes(2);
      expect(mockShareProject.mock.calls[1]).toEqual(["p1", "u2", -1]);
    });

    it("keeps each user's loading state while another user's change settles", async () => {
      const u1 = deferred();
      const u2 = deferred();
      mockShareProject
        .mockReturnValueOnce(u1.promise)
        .mockReturnValueOnce(u2.promise);
      const vm = mountComponent().vm as any;
      vm.users = [user("u1"), user("u2")];

      const first = vm.updateUserAccess(vm.users[0], 1);
      const second = vm.updateUserAccess(vm.users[1], 1);
      expect(vm.isUserPending("u1")).toBe(true);
      expect(vm.isUserPending("u2")).toBe(true);
      u2.resolve(undefined);
      await second;
      expect(vm.isUserPending("u1")).toBe(true);
      expect(vm.isUserPending("u2")).toBe(false);
      u1.resolve(undefined);
      await first;
      expect(vm.isUserPending("u1")).toBe(false);
    });

    it("clears a pending confirmation and the loading spinner on close", async () => {
      mockGetProjectAccess.mockReturnValue(new Promise(() => {}));
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      await wrapper.setProps({ modelValue: true });
      expect(vm.loading).toBe(true);
      vm.confirmRemoveUser(user("u1"));
      expect(vm.confirmDialog).toBe(true);

      await wrapper.setProps({ modelValue: false });

      expect(vm.confirmDialog).toBe(false);
      expect(vm.pendingAction).toBe(null);
      expect(vm.loading).toBe(false);
    });

    it("ignores an access list from a previous dialog session", async () => {
      const firstLoad = deferred();
      const secondLoad = deferred();
      mockGetProjectAccess
        .mockReturnValueOnce(firstLoad.promise)
        .mockReturnValueOnce(secondLoad.promise);
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      await wrapper.setProps({ modelValue: true });
      await wrapper.setProps({ modelValue: false });
      await wrapper.setProps({ modelValue: true });

      secondLoad.resolve({ public: false, users: [user("new")] });
      await flushPromises();
      firstLoad.resolve({ public: true, users: [user("old")] });
      await flushPromises();

      expect(vm.users.map((u: any) => u.id)).toEqual(["new"]);
      expect(vm.isPublic).toBe(false);
      expect(vm.loading).toBe(false);
    });

    it("does not show a previous session's share failure in a reopened dialog", async () => {
      const share = deferred();
      mockShareProject.mockReturnValueOnce(share.promise);
      mockGetProjectAccess.mockResolvedValue({ public: false, users: [] });
      const wrapper = mountComponent();
      const vm = wrapper.vm as any;
      await wrapper.setProps({ modelValue: true });
      await flushPromises();
      const pending = vm.updateUserAccess(user("u1"), 1);
      await wrapper.setProps({ modelValue: false });
      await wrapper.setProps({ modelValue: true });
      await flushPromises();
      // Still in flight across the reopen.
      expect(vm.isUserPending("u1")).toBe(true);

      share.reject(new Error("network"));
      await pending;
      await flushPromises();

      // errorString, not showError: the reload below clears showError.
      expect(vm.errorString).toBe("");
      expect(vm.showError).toBe(false);
      expect(vm.isUserPending("u1")).toBe(false);
      // Reloaded, since the reopened dialog loaded mid-change.
      expect(mockGetProjectAccess).toHaveBeenCalledTimes(3);
    });
  });
});

import { describe, it, expect, afterEach } from "vitest";
import { defineComponent, h, nextTick, ref } from "vue";
import { mount } from "@vue/test-utils";
import {
  allCommands,
  enabledCommands,
  registerCommandProvider,
  useCommand,
} from "./registry";
import { ICommand } from "./types";

function command(id: string, extra: Partial<ICommand> = {}): ICommand {
  return { id, title: id, group: "Actions", run: () => {}, ...extra };
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
});

describe("command registry", () => {
  it("useCommand registers for the component's lifetime", async () => {
    const Owner = defineComponent({
      setup() {
        useCommand(command("owned.command"));
        return () => h("div");
      },
    });
    const wrapper = mount(Owner);
    expect(allCommands.value.map((c) => c.id)).toContain("owned.command");
    wrapper.unmount();
    await nextTick();
    expect(allCommands.value.map((c) => c.id)).not.toContain("owned.command");
  });

  it("re-derives a getter registration when its reactive input changes", () => {
    const label = ref("first");
    cleanups.push(
      registerCommandProvider(() => [command("live", { title: label.value })]),
    );
    expect(allCommands.value.find((c) => c.id === "live")?.title).toBe("first");
    label.value = "second";
    expect(allCommands.value.find((c) => c.id === "live")?.title).toBe(
      "second",
    );
  });

  it("keeps the first registration of a duplicated id", () => {
    cleanups.push(
      registerCommandProvider(() => [command("dup", { title: "first" })]),
      registerCommandProvider(() => [command("dup", { title: "second" })]),
    );
    const dups = allCommands.value.filter((c) => c.id === "dup");
    expect(dups.map((c) => c.title)).toEqual(["first"]);
  });

  it("hides commands whose enabled() is false, reactively", () => {
    const allowed = ref(false);
    cleanups.push(
      registerCommandProvider(() => [
        command("gated", { enabled: () => allowed.value }),
      ]),
    );
    expect(enabledCommands.value.map((c) => c.id)).not.toContain("gated");
    allowed.value = true;
    expect(enabledCommands.value.map((c) => c.id)).toContain("gated");
  });
});

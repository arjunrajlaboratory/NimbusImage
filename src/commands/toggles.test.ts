import { describe, it, expect } from "vitest";
import { ref } from "vue";
import { toggleCommands } from "./toggles";

describe("toggleCommands", () => {
  it("titles each command by what running it will do, and flips the setting", () => {
    const scalebar = ref(true);
    const minimap = ref(false);
    const build = () =>
      toggleCommands([
        {
          id: "s",
          setting: scalebar,
          turnOn: "Show scale bar",
          turnOff: "Hide scale bar",
        },
        {
          id: "m",
          setting: minimap,
          turnOn: "Show minimap",
          turnOff: "Hide minimap",
        },
      ]);
    const [s, m] = build();
    expect([s.title, m.title]).toEqual(["Hide scale bar", "Show minimap"]);
    s.run();
    m.run();
    expect([scalebar.value, minimap.value]).toEqual([false, true]);
    expect(build().map((c) => c.title)).toEqual([
      "Show scale bar",
      "Hide minimap",
    ]);
  });
});

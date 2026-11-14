import { describe, it, expect, vi, afterEach } from "vitest";
import { mount } from "@vue/test-utils";
import { tourTriggerDirective } from "./tour-trigger.directive";
import { tourBus } from "./tourBus";

describe("v-tour-trigger", () => {
  const heard = vi.fn();
  afterEach(() => {
    tourBus.off("*", heard);
    heard.mockReset();
  });

  function mountButton(trigger: string | undefined) {
    return mount(
      {
        template: '<button v-tour-trigger="trigger"></button>',
        data: () => ({ trigger }),
      },
      { global: { directives: { "tour-trigger": tourTriggerDirective } } },
    );
  }

  it("announces its trigger when clicked", async () => {
    tourBus.on("*", heard);
    await mountButton("object-list-button").trigger("click");
    expect(heard).toHaveBeenCalledWith("object-list-button", undefined);
  });

  // The panel chips share one template, and only some are tour anchors.
  it("announces nothing without a trigger", async () => {
    tourBus.on("*", heard);
    await mountButton(undefined).trigger("click");
    expect(heard).not.toHaveBeenCalled();
  });
});

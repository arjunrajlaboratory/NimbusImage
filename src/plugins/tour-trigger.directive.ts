import type { DirectiveBinding } from "vue";
import { tourBus } from "./tourBus";

export const tourTriggerDirective = {
  mounted(el: HTMLElement, binding: DirectiveBinding) {
    const handler = () => {
      tourBus.emit(binding.value);
    };
    el.addEventListener("click", handler);
    // Store the handler function on the element so we can remove it later
    (el as any)._tourTriggerHandler = handler;
  },

  unmounted(el: HTMLElement) {
    // Remove the event listener using the stored handler
    if ((el as any)._tourTriggerHandler) {
      el.removeEventListener("click", (el as any)._tourTriggerHandler);
      delete (el as any)._tourTriggerHandler;
    }
  },
};

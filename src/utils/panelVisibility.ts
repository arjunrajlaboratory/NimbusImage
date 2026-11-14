import { InjectionKey, Ref, inject, ref } from "vue";

/**
 * Whether the palette hosting a component is on screen.
 *
 * Palette content stays mounted while its palette is closed, minimized or
 * hidden, and remembered state (an expanded row, an active tab) is in effect
 * from page load. A component deep inside a palette uses this to keep such
 * state from doing its work where nobody can see it, without the flag being
 * threaded through every component in between. The palette's content root
 * provides it from the `visible` prop App.vue passes.
 */
export const PANEL_VISIBLE_KEY: InjectionKey<Ref<boolean>> =
  Symbol("panelVisible");

/** The hosting palette's visibility; true when nothing provides it. */
export function usePanelVisible(): Ref<boolean> {
  return inject(PANEL_VISIBLE_KEY, ref(true));
}

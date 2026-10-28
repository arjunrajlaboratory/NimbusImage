import { ref } from "vue";

/**
 * Whether the app's one "Genes from the spatial table" dialog is open.
 *
 * The dialog lives in App.vue, which is always mounted, and every "Add genes"
 * button opens it through this flag. A dialog hosted inside another dialog or
 * a tab would be unmounted when that host closes. Unmounting retires its job
 * polling (useJobPolling), so a copy or score job started from it would never
 * refresh the values it writes.
 */
export const genesDialogOpen = ref(false);

export function openGenesDialog(): void {
  genesDialogOpen.value = true;
}

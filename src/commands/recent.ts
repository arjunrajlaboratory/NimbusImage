import { ref } from "vue";

// Recently run command ids, most recent first. Session memory only: a command
// id can name a tool, layer or snapshot of one dataset, so persisting it would
// mostly resurface ids that match nothing in the next session.
export const MAX_RECENT_COMMANDS = 8;

export const recentCommandIds = ref<string[]>([]);

export function recordRecentCommand(id: string) {
  recentCommandIds.value = [
    id,
    ...recentCommandIds.value.filter((recentId) => recentId !== id),
  ].slice(0, MAX_RECENT_COMMANDS);
}

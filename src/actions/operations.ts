import main from "@/store";

// Store-mutating cores of the actions both dispatchers perform: the AI agent's
// tool executors (src/agent/executors.ts) and the command palette
// (src/actions/catalog.ts, src/commands/providers.ts). One implementation,
// two dispatchers. Agent-only concerns (input validation, ToolExecutionError,
// result payloads, login gates, error-throwing persistence) stay in the
// executors; the callers persist.

export interface ILocation {
  xy: number;
  z: number;
  time: number;
}

function clampIndex(value: number, length: number) {
  return Math.max(0, Math.min(value, Math.max(0, length - 1)));
}

/**
 * Move the viewer to a location. Indices are 0-based and clamped to the
 * dataset's range; omitted axes stay put. Without a dataset nothing moves.
 * Returns the resulting location.
 */
export async function goToLocation(target: {
  xy?: number;
  z?: number;
  time?: number;
}): Promise<ILocation> {
  const dataset = main.dataset;
  if (dataset) {
    if (target.xy != null) {
      await main.setXY(clampIndex(target.xy, dataset.xy.length));
    }
    if (target.z != null) {
      await main.setZ(clampIndex(target.z, dataset.z.length));
    }
    if (target.time != null) {
      await main.setTime(clampIndex(target.time, dataset.time.length));
    }
  }
  return { xy: main.xy, z: main.z, time: main.time };
}

/**
 * Make exactly these layers visible (declaratively), touching only layers
 * whose visibility differs. Does NOT persist: callers sync the "layers"
 * configuration key themselves (the agent throws on failure, the palette
 * syncs only when logged in).
 */
export async function setVisibleLayers(layerIds: string[]): Promise<void> {
  const visibleIds = new Set(layerIds);
  for (const layer of main.layers) {
    const visible = visibleIds.has(layer.id);
    if (layer.visible !== visible) {
      await main.changeLayer({
        layerId: layer.id,
        delta: { visible },
        sync: false,
      });
    }
  }
}

/** Activate a tool by id, or deselect with null. */
export async function selectTool(toolId: string | null): Promise<void> {
  await main.setSelectedToolId(toolId);
}

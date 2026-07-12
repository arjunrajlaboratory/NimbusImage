// Panel-local registry for AI-panel plots. Plot data (large Plotly trace
// arrays) must live OUTSIDE Vuex — no reactivity is wanted, same reasoning as
// wireMessages — and this module is imported by both executors.ts and the
// aiPanel store, so it must not import either (circular import).

export interface IAgentPlot {
  id: string; // "plot-<n>"
  title: string;
  data: unknown[]; // Plotly traces
  layout: Record<string, unknown>; // titles/axis labels only; theming at render
}

const plots = new Map<string, IAgentPlot>();
let nextId = 1;

export function registerPlot(plot: Omit<IAgentPlot, "id">): IAgentPlot {
  const registered: IAgentPlot = { ...plot, id: `plot-${nextId++}` };
  plots.set(registered.id, registered);
  return registered;
}

export function getPlot(id: string): IAgentPlot | undefined {
  return plots.get(id);
}

export function listPlots(): IAgentPlot[] {
  return Array.from(plots.values());
}

// Replace the registry contents with restored plots (hydration), advancing the
// id counter past the highest numeric "plot-<n>" suffix so freshly registered
// plots never collide with restored ids.
export function restorePlots(restored: IAgentPlot[]): void {
  plots.clear();
  for (const plot of restored) {
    plots.set(plot.id, plot);
    const suffix = Number(plot.id.replace(/^plot-/, ""));
    if (Number.isFinite(suffix) && suffix >= nextId) {
      nextId = suffix + 1;
    }
  }
}

// Empty the registry without resetting the id counter.
export function clearPlots(): void {
  plots.clear();
}

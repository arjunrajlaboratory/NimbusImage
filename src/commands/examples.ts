// Example queries for the command palette's placeholder ("Try: z 3 · show
// only DAPI · add column Area"). A first query that finds nothing loses the user,
// so the examples are built from the open dataset (a slice, layer or property
// that exists here), and each names the command it demonstrates: it is shown
// only while that command is what Enter would run for it.

export interface IExampleContext {
  inViewer: boolean;
  isLoggedIn: boolean;
  zCount: number;
  timeCount: number;
  layerNames: string[];
  // Last segment of each property value path ("Area", a gene name).
  propertyNames: string[];
}

export interface IExample {
  query: string;
  // Id (or id prefix, for per-layer / per-property commands) of the command
  // this example demonstrates.
  target: string;
  // The target flips with state (one id, two directions). Its query must
  // then carry a direction word from stateWords.ts ("hide minimap", "add
  // column Area"): a neutral one ("minimap", "list Area") tops out at the
  // same id in either state and would run the opposite (tested).
  flips?: boolean;
}

/** How many examples the placeholder shows at once. */
export const EXAMPLES_SHOWN = 3;

export function paletteExamples(ctx: IExampleContext): IExample[] {
  const ex = (query: string, target: string, flips = false): IExample => ({
    query,
    target,
    flips,
  });
  if (!ctx.inViewer) {
    return [
      ...(ctx.isLoggedIn ? [ex("upload", "data.upload")] : []),
      ex("tour", "tour."),
      ex("docs", "help.docs"),
    ];
  }
  const examples: IExample[] = [];
  if (ctx.zCount > 1) {
    examples.push(ex(`z ${Math.min(3, ctx.zCount)}`, "navigate.z:"));
  }
  if (ctx.layerNames.length > 1) {
    examples.push(ex(`show only ${ctx.layerNames[0]}`, "layers.showOnly:"));
  }
  if (ctx.propertyNames.length > 0) {
    const name =
      ctx.propertyNames.find((n) => /area/i.test(n)) ?? ctx.propertyNames[0];
    examples.push(
      ex(`add column ${name}`, "property.list.", true),
      ex(`color by ${name}`, "property.colorBy."),
    );
  }
  if (ctx.timeCount > 1) {
    examples.push(ex(`t ${Math.min(10, ctx.timeCount)}`, "navigate.time:"));
  }
  if (ctx.zCount > 1) {
    examples.push(ex("merge z", "layers.toggleZMaxMergeAll", true));
  }
  // Toggles get both directions; only the one its command answers in the
  // current state survives examplesThatRun.
  examples.push(
    ex("open objects", "panel.toggle.annotationPanel", true),
    ex("hide objects", "objects.toggleDraw", true),
    ex("show objects", "objects.toggleDraw", true),
    ex("measure", "analysis.measure"),
    ex("hide minimap", "settings.minimap", true),
    ex("show minimap", "settings.minimap", true),
    ex("open snapshots", "panel.toggle.snapshotPanel", true),
  );
  return examples;
}

/**
 * The queries whose top result (what Enter runs) is the command they
 * demonstrate. "Finds something" is not enough: a state-flipping command
 * answers only the verb of what it will do, so a fixed example can fall
 * through to an unrelated command.
 */
export function examplesThatRun(
  examples: IExample[],
  topCommandId: (query: string) => string | undefined,
): string[] {
  return examples
    .filter(({ query, target }) => topCommandId(query)?.startsWith(target))
    .map(({ query }) => query);
}

/**
 * The `EXAMPLES_SHOWN` examples starting at `offset`, wrapping around, as the
 * placeholder text. Fewer examples than slots shows each once.
 */
export function examplePlaceholder(examples: string[], offset: number) {
  if (examples.length === 0) {
    return "Search commands";
  }
  const count = Math.min(EXAMPLES_SHOWN, examples.length);
  const shown = Array.from(
    { length: count },
    (_, i) => examples[(offset + i) % examples.length],
  );
  return `Try: ${shown.join(" · ")}`;
}

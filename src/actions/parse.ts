import store from "@/store";
import { ICommand } from "@/commands/types";
import { IProviderContext } from "@/commands/context";
import { normalize, rankCommands } from "@/commands/scorer";
import { IParamAction, PARAM_ACTIONS, TDimension } from "./catalog";

// Instantiates the catalog's parameterized actions from the palette query, so
// typing "z 12" yields a ready-to-run "Go to Z 12". Runs on every keystroke:
// it normalizes the query, matches a phrase and builds a handful of commands,
// reading no per-annotation state and re-deriving no provider.

// With the phrase alone ("show only"), how many choices to list.
export const MAX_CHOICES = 8;

const PHRASES_LONGEST_FIRST = PARAM_ACTIONS.flatMap((action) =>
  action.phrases.map((phrase) => ({ action, phrase: normalize(phrase) })),
).sort((a, b) => b.phrase.length - a.phrase.length);

/** The action whose longest phrase prefixes the query, with the remainder. */
function matchPhrase(
  query: string,
): { action: IParamAction; rest: string } | null {
  for (const { action, phrase } of PHRASES_LONGEST_FIRST) {
    if (query === phrase) {
      return { action, rest: "" };
    }
    if (query.startsWith(`${phrase} `)) {
      return { action, rest: query.slice(phrase.length + 1).trim() };
    }
    // Glued form: "z12", "t40", "xy3".
    if (
      action.param.kind === "index" &&
      query.startsWith(phrase) &&
      /^\d+$/.test(query.slice(phrase.length))
    ) {
      return { action, rest: query.slice(phrase.length) };
    }
  }
  return null;
}

function dimensionLength(dimension: TDimension): number {
  return store.dataset?.[dimension]?.length ?? 0;
}

function indexCommands(action: IParamAction, rest: string): ICommand[] {
  const param = action.param;
  if (param.kind !== "index" || !/^\d+$/.test(rest)) {
    return [];
  }
  const length = dimensionLength(param.dimension);
  // The Navigator sliders show 1-based numbers (NavigatorPanel :offset="1"),
  // so the typed N is index N - 1.
  const typed = Number(rest);
  if (length <= 1 || typed < 1 || typed > length) {
    return [];
  }
  const index = typed - 1;
  return [
    {
      id: `${action.id}:${index}`,
      title: action.title(String(typed)),
      group: action.group,
      icon: action.icon,
      description: `of ${length}`,
      generated: true,
      run: () => action.run(index),
    },
  ];
}

function choiceCommands(action: IParamAction, rest: string): ICommand[] {
  const param = action.param;
  if (param.kind !== "choice") {
    return [];
  }
  const candidates = param.choices().map(
    (choice): ICommand => ({
      id: `${action.id}:${choice.value}`,
      title: action.title(choice.label),
      group: action.group,
      icon: action.icon,
      keywords: [choice.label, ...(choice.keywords ?? [])],
      generated: true,
      run: () => action.run(choice.value),
    }),
  );
  // Match the argument with the palette's scorer (synonyms, channel names),
  // against the layer's label and keywords rather than the full title.
  return rest
    ? rankCommands(
        candidates.map((candidate) => ({
          ...candidate,
          title: candidate.keywords?.[0] ?? candidate.title,
        })),
        rest,
        MAX_CHOICES,
      ).map((ranked) => candidates.find((c) => c.id === ranked.id)!)
    : candidates.slice(0, MAX_CHOICES);
}

/** The ready-to-run commands the query spells out; [] when it names none. */
export function paramCommandsForQuery(
  query: string,
  ctx: IProviderContext,
): ICommand[] {
  const q = normalize(query);
  if (!q) {
    return [];
  }
  const match = matchPhrase(q);
  if (!match || !match.action.enabled(ctx)) {
    return [];
  }
  return match.action.param.kind === "index"
    ? indexCommands(match.action, match.rest)
    : choiceCommands(match.action, match.rest);
}

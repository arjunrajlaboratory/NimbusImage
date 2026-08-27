import {
  TWorkerInterfaceElement,
  TWorkerInterfaceType,
  TWorkerInterfaceValue,
} from "@/store/model";

export function getDefault(
  type: TWorkerInterfaceType,
  defaultValue?: TWorkerInterfaceValue,
) {
  if (defaultValue) {
    return defaultValue;
  }
  switch (type) {
    case "number":
      return 0.0;

    case "notes":
      return "";

    case "text":
      return "";

    case "tags":
      return [];

    case "layer":
      return null;

    case "select":
      return "";

    case "channel":
      return 0;

    case "channelCheckboxes":
      return {};

    case "checkbox":
      return false;
  }
}

// Human-readable description of the value each worker-interface parameter type
// expects. Surfaced to the AI agent by get_worker_interface so it fills every
// parameter in the right shape (see AI_PANEL_SPEC.md). The wording assumes the
// agent also has the dataset's channel index↔name list for channel params.
export const WORKER_INTERFACE_VALUE_FORMATS: Record<
  TWorkerInterfaceType,
  string
> = {
  number: "A number. Respect this parameter's min/max/step if given.",
  notes:
    "Informational text shown to the user — NOT an input. Do not set a value " +
    "for a notes parameter.",
  text: "A string.",
  tags: 'An array of tag strings, e.g. ["nucleus"].',
  layer: "A layer id string, or null for none.",
  select:
    'Exactly one of the strings listed in this parameter\'s "items" array.',
  channel:
    'A single 0-based channel index number (see the "channels" list for the ' +
    "index↔name mapping). Pass a number, not a channel name.",
  channelCheckboxes:
    "The channel(s) to use for this slot, as an ARRAY of 0-based channel " +
    'indices — e.g. [0] selects the first channel (see the "channels" list ' +
    "for the index↔name mapping). To select the DAPI channel, pass the index " +
    "DAPI has in that list; pass [] to select nothing (optional slots only). " +
    "An object mapping channel index to a true/false BOOLEAN also works, e.g. " +
    '{"0": true, "1": false} — but the value must be literally true to select ' +
    'a channel: {"0": 0} selects nothing and is rejected.',
  checkbox: "A boolean: true or false.",
};

// Context for resolving channel references (indices or names) against the open
// dataset. `channels` is every channel index present (e.g. [0, 1, 2, 3]);
// `nameToIndex` maps a lower-cased channel name to its index.
export interface IChannelContext {
  channels: number[];
  nameToIndex: Map<string, number>;
}

// "Available channels: 0 (dapi), 1 (fitc)." for error messages, or "" when the
// dataset's channels are unknown. Called only on failure paths — building it
// eagerly would walk the channel list on every successful resolution.
function describeAvailableChannels(ctx: IChannelContext): string {
  if (ctx.channels.length === 0) {
    return "";
  }
  const indexToName = new Map(
    [...ctx.nameToIndex.entries()].map(([name, index]) => [index, name]),
  );
  const described = ctx.channels.map((channel) => {
    const name = indexToName.get(channel);
    return name ? `${channel} (${name})` : `${channel}`;
  });
  return ` Available channels: ${described.join(", ")}.`;
}

// Resolve one channel reference — a 0-based index number, a numeric string, or
// a channel name — to a channel index. Throws a descriptive Error when it does
// not correspond to a channel in the dataset.
function resolveChannelRef(
  ref: unknown,
  ctx: IChannelContext,
  paramId: string,
): number {
  const validate = (index: number): number => {
    if (ctx.channels.length > 0 && !ctx.channels.includes(index)) {
      throw new Error(
        `"${paramId}": channel index ${index} does not exist in this ` +
          `dataset.${describeAvailableChannels(ctx)}`,
      );
    }
    return index;
  };
  if (typeof ref === "number") {
    if (!Number.isInteger(ref)) {
      throw new Error(
        `"${paramId}": channel index ${ref} must be a whole number.`,
      );
    }
    return validate(ref);
  }
  if (typeof ref === "string") {
    const trimmed = ref.trim();
    if (/^\d+$/.test(trimmed)) {
      return validate(parseInt(trimmed, 10));
    }
    const byName = ctx.nameToIndex.get(trimmed.toLowerCase());
    if (byName == null) {
      throw new Error(
        `"${paramId}": unknown channel "${ref}".` +
          describeAvailableChannels(ctx),
      );
    }
    return byName;
  }
  throw new Error(
    `"${paramId}": expected a channel index or name, got ${JSON.stringify(
      ref,
    )}.`,
  );
}

// Normalize a value the agent provided for one worker-interface parameter into
// the canonical shape the worker and UI expect. Channel selections may be given
// as indices, names, or arrays and are normalized to the on-disk forms (a
// number for `channel`, a {index: boolean} map for `channelCheckboxes`). Throws
// a descriptive Error for values that can't be made valid, so the agent gets
// actionable feedback instead of silently producing a broken tool.
export function normalizeWorkerInterfaceValue(
  element: TWorkerInterfaceElement,
  value: unknown,
  ctx: IChannelContext,
  paramId: string,
): TWorkerInterfaceValue {
  switch (element.type) {
    case "channel": {
      if (value == null) {
        if (element.required) {
          throw new Error(`"${paramId}": a channel is required.`);
        }
        return null;
      }
      return resolveChannelRef(value, ctx, paramId);
    }
    case "channelCheckboxes": {
      const selected = new Set<number>();
      // Set when a map value is falsy but NOT boolean false (e.g. {"0": 0}):
      // the agent put the channel index in the value slot, so it meant to
      // select that channel and selected nothing. An explicit all-`false` map
      // (the canonical UI shape) and an empty array are deliberate "select
      // nothing" — legitimate for the optional slots — and must not throw.
      let indexUsedAsValue = false;
      if (value == null) {
        // Treated as "nothing selected"; the caller omitted the parameter.
      } else if (Array.isArray(value)) {
        for (const ref of value) {
          selected.add(resolveChannelRef(ref, ctx, paramId));
        }
      } else if (typeof value === "number" || typeof value === "string") {
        selected.add(resolveChannelRef(value, ctx, paramId));
      } else if (typeof value === "object") {
        for (const [key, isSelected] of Object.entries(
          value as Record<string, unknown>,
        )) {
          if (isSelected) {
            selected.add(resolveChannelRef(key, ctx, paramId));
          } else if (isSelected !== false) {
            indexUsedAsValue = true;
          }
        }
      } else {
        throw new Error(
          `"${paramId}": expected an array of channel indices, e.g. [0].`,
        );
      }
      // Surface the misuse so the agent retries, rather than saving a tool that
      // fails at run time with the worker's "No channel selected for Slot 1".
      if (indexUsedAsValue) {
        throw new Error(
          `"${paramId}": a channel index was used as a map value (e.g. ` +
            '{"0": 0}), which selects nothing. Pass the channel indices to ' +
            "select as an array, e.g. [0] for the first channel.",
        );
      }
      // Every channel gets an explicit boolean, matching what the checkbox UI
      // writes. resolveChannelRef already rejected indices outside
      // ctx.channels, so `selected` never adds keys beyond this loop's range.
      const result: { [channel: number]: boolean } = {};
      const channels =
        ctx.channels.length > 0 ? ctx.channels : [...selected].sort();
      for (const channel of channels) {
        result[channel] = selected.has(channel);
      }
      return result;
    }
    case "select": {
      if (value == null) {
        return getDefault(element.type, element.default);
      }
      const items = element.items ?? [];
      if (items.length > 0 && !items.includes(value as string)) {
        throw new Error(
          `"${paramId}": "${value}" is not a valid option. Choose one of: ` +
            `${items.join(", ")}.`,
        );
      }
      return value as TWorkerInterfaceValue;
    }
    case "checkbox":
      // Deliberately strict: Boolean("false") is true, so coercing would turn a
      // stringy "false" into an enabled option the caller never asked for.
      if (typeof value !== "boolean") {
        throw new Error(
          `"${paramId}": expected true or false, got ` +
            `${JSON.stringify(value)}.`,
        );
      }
      return value;
    case "number": {
      // Also deliberately strict: Number("") and Number([]) are 0, so coercing
      // would silently substitute 0 for a value that was never a number.
      let asNumber: number;
      if (typeof value === "number") {
        asNumber = value;
      } else if (typeof value === "string" && value.trim() !== "") {
        asNumber = Number(value);
      } else {
        asNumber = NaN;
      }
      if (!Number.isFinite(asNumber)) {
        throw new Error(
          `"${paramId}": expected a number, got ${JSON.stringify(value)}.`,
        );
      }
      return asNumber;
    }
    default:
      // text, notes, tags, layer — pass through unchanged.
      return value as TWorkerInterfaceValue;
  }
}

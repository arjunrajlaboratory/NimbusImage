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
    "DAPI has in that list. You may also pass an object mapping channel index " +
    'to true/false, e.g. {"0": true, "1": false}, but the value MUST be true ' +
    "to select a channel — the key alone does not select it.",
  checkbox: "A boolean: true or false.",
};

// Context for resolving channel references (indices or names) against the open
// dataset. `channels` is every channel index present (e.g. [0, 1, 2, 3]);
// `nameToIndex` maps a lower-cased channel name to its index.
export interface IChannelContext {
  channels: number[];
  nameToIndex: Map<string, number>;
}

// Resolve one channel reference — a 0-based index number, a numeric string, or
// a channel name — to a channel index. Throws a descriptive Error when it does
// not correspond to a channel in the dataset.
function resolveChannelRef(
  ref: unknown,
  ctx: IChannelContext,
  paramId: string,
): number {
  const available =
    ctx.channels.length > 0
      ? ` Available channels: ${ctx.channels
          .map((c) => {
            const name = [...ctx.nameToIndex.entries()].find(
              ([, idx]) => idx === c,
            )?.[0];
            return name ? `${c} (${name})` : `${c}`;
          })
          .join(", ")}.`
      : "";
  const validate = (index: number): number => {
    if (ctx.channels.length > 0 && !ctx.channels.includes(index)) {
      throw new Error(
        `"${paramId}": channel index ${index} does not exist in this ` +
          `dataset.${available}`,
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
      throw new Error(`"${paramId}": unknown channel "${ref}".${available}`);
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
      let provided = false;
      if (value == null) {
        provided = false;
      } else if (Array.isArray(value)) {
        provided = value.length > 0;
        for (const ref of value) {
          selected.add(resolveChannelRef(ref, ctx, paramId));
        }
      } else if (typeof value === "number" || typeof value === "string") {
        provided = true;
        selected.add(resolveChannelRef(value, ctx, paramId));
      } else if (typeof value === "object") {
        const entries = Object.entries(value as Record<string, unknown>);
        provided = entries.length > 0;
        for (const [key, selectedFlag] of entries) {
          if (selectedFlag) {
            selected.add(resolveChannelRef(key, ctx, paramId));
          }
        }
      } else {
        throw new Error(
          `"${paramId}": expected an array of channel indices, e.g. [0].`,
        );
      }
      // A value was supplied but nothing ended up selected — almost always the
      // agent passed the channel index as the map value (e.g. {"0": 0}) instead
      // of true. Surface it so the agent retries rather than saving a tool that
      // fails at run time with "No channel selected".
      if (provided && selected.size === 0) {
        throw new Error(
          `"${paramId}": you provided a value but no channel is selected. ` +
            "Pass the channel indices to select as an array, e.g. [0] for the " +
            "first channel.",
        );
      }
      const result: { [channel: number]: boolean } = {};
      const channels =
        ctx.channels.length > 0 ? ctx.channels : [...selected].sort();
      for (const channel of channels) {
        result[channel] = selected.has(channel);
      }
      for (const channel of selected) {
        if (!(channel in result)) {
          result[channel] = true;
        }
      }
      return result;
    }
    case "select": {
      if (value == null) {
        return getDefault(element.type, element.default) ?? "";
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
      return Boolean(value);
    case "number": {
      const asNumber = typeof value === "number" ? value : Number(value);
      if (Number.isNaN(asNumber)) {
        throw new Error(`"${paramId}": expected a number, got ${value}.`);
      }
      return asNumber;
    }
    default:
      // text, notes, tags, layer — pass through unchanged.
      return value as TWorkerInterfaceValue;
  }
}

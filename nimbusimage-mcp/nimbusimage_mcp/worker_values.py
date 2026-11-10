"""Worker parameter values: defaults and normalization.

A port of ``getDefault`` and ``normalizeWorkerInterfaceValue`` in
src/utils/workerInterface.ts, so a worker started from MCP receives the
same value shapes as one started from the app. Keep the two in step.
"""

from __future__ import annotations

import math
import re

# Adapted from WORKER_INTERFACE_VALUE_FORMATS in
# src/utils/workerInterface.ts (this port also accepts channel names).
VALUE_FORMATS = {
    "number": "A number. Respect this parameter's min/max if given.",
    "notes": "Informational text, not an input; do not set it.",
    "text": "A string.",
    "tags": 'An array of tag strings, e.g. ["nucleus"].',
    "layer": "A layer id string, or null for none.",
    "select": "Exactly one of the strings in this parameter's items.",
    "channel": (
        "A single 0-based channel index (see channels). A channel name "
        "also works."
    ),
    "channelCheckboxes": (
        "An array of 0-based channel indices, e.g. [0] for the first "
        "channel (see channels); [] selects none (optional slots only)."
    ),
    "checkbox": "true or false.",
}

_TYPE_DEFAULTS = {
    "number": 0.0, "notes": "", "text": "", "tags": [], "layer": None,
    "select": "", "channel": 0, "channelCheckboxes": {}, "checkbox": False,
}


def default_value(element: dict):
    """getDefault: the interface's default when truthy, else the type's."""
    if element.get("default"):
        return element["default"]
    value = _TYPE_DEFAULTS.get(element.get("type"))
    return value.copy() if isinstance(value, (list, dict)) else value


def _available(channels: list[str]) -> str:
    if not channels:
        return ""
    return " Available channels: " + ", ".join(
        f"{i} ({name})" if name else str(i)
        for i, name in enumerate(channels)
    ) + "."


def _channel_index(ref, channels: list[str], param: str) -> int:
    """A channel index from an index, a numeric string, or a name."""
    def check(index: int) -> int:
        if channels and not 0 <= index < len(channels):
            raise ValueError(
                f'"{param}": channel index {index} does not exist in this '
                f"dataset.{_available(channels)}"
            )
        return index

    if isinstance(ref, bool):
        raise ValueError(f'"{param}": expected a channel index, got {ref}.')
    if isinstance(ref, int):
        return check(ref)
    if isinstance(ref, float):
        if not ref.is_integer():
            raise ValueError(
                f'"{param}": channel index {ref} must be a whole number.'
            )
        return check(int(ref))
    if isinstance(ref, str):
        text = ref.strip()
        if re.fullmatch(r"[0-9]+", text):
            return check(int(text))
        lowered = [name.lower() for name in channels]
        # "" marks a channel without a name; it matches nothing.
        if text and text.lower() in lowered:
            return lowered.index(text.lower())
        raise ValueError(
            f'"{param}": unknown channel "{ref}".{_available(channels)}'
        )
    raise ValueError(
        f'"{param}": expected a channel index or name, got {ref!r}.'
    )


def normalize(element: dict, value, channels: list[str], param: str):
    """One caller-supplied value in the shape the worker expects; a
    ValueError says what is wrong in words the model can act on."""
    kind = element.get("type")
    if kind == "channel":
        if value is None:
            if element.get("required"):
                raise ValueError(f'"{param}": a channel is required.')
            return None
        return _channel_index(value, channels, param)
    if kind == "channelCheckboxes":
        selected = set()
        if value is None:
            pass
        elif isinstance(value, list):
            selected = {_channel_index(v, channels, param) for v in value}
        elif isinstance(value, (int, float, str)) \
                and not isinstance(value, bool):
            selected = {_channel_index(value, channels, param)}
        elif isinstance(value, dict):
            for key, on in value.items():
                # As in the app: any truthy value selects; a falsy one
                # other than false is an index typed in the value slot.
                if on:
                    selected.add(_channel_index(key, channels, param))
                elif on is not False:
                    raise ValueError(
                        f'"{param}": a channel index was used as a map '
                        'value (e.g. {"0": 0}), which selects nothing. '
                        "Pass the channel indices as an array, e.g. [0]."
                    )
        else:
            raise ValueError(
                f'"{param}": expected an array of channel indices, e.g. [0].'
            )
        indices = range(len(channels)) if channels else sorted(selected)
        return {str(i): i in selected for i in indices}
    if kind == "select":
        if value is None:
            return default_value(element)
        items = element.get("items") or []
        if items and value not in items:
            raise ValueError(
                f'"{param}": "{value}" is not a valid option. Choose one '
                f"of: {', '.join(map(str, items))}."
            )
        return value
    if kind == "checkbox":
        # Strict: "false" as a string must not become true.
        if not isinstance(value, bool):
            raise ValueError(f'"{param}": expected true or false, got '
                             f"{value!r}.")
        return value
    if kind == "number":
        # Strict too: "" and [] must not become 0.
        number = None
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            number = value
        elif isinstance(value, str) and value.strip():
            try:
                number = float(value)
            except ValueError:
                pass
        if number is None or not math.isfinite(number):
            raise ValueError(f'"{param}": expected a number, got {value!r}.')
        return number
    # text, notes, tags, layer: passed through.
    return value


def resolve(interface: dict, overrides: dict, channels: list[str]) -> dict:
    """Every parameter's value: the override, normalized, else the
    default (resolveWorkerInterfaceValues in src/agent/executors.ts)."""
    unknown = [key for key in overrides if key not in interface]
    if unknown:
        raise ValueError(
            f"Unknown worker parameters: {', '.join(unknown)}. Valid "
            f"parameters: {', '.join(interface)}."
        )
    return {
        param: (
            normalize(element, overrides[param], channels, param)
            if param in overrides else default_value(element)
        )
        for param, element in interface.items()
    }

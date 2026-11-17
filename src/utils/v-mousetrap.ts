import Mousetrap from "mousetrap";
import { isArray } from "lodash";
import { ref } from "vue";

export interface IHotkey {
  bind: string;
  handler: Function;
  disabled?: boolean;
  data?: IHotkeyDescription;
  // Fire even while focus is in a text field, which Mousetrap otherwise
  // ignores. For keys with no typing meaning that must work everywhere (the
  // ⌘K command palette); never for a plain letter or digit.
  allowInInputs?: boolean;
}

export interface IHotkeyDescription {
  section: string;
  description: string;
}

// Internal mutable store — not reactive, so directive hooks don't create
// dependency-tracking loops when they run inside a component's render watcher.
// Keyed by key, then by the element that bound it: Mousetrap runs every
// handler bound to a key, so several bindings can share one (a tool hotkey
// and a built-in key), and unbinding one must leave the others listed.
const _raw = new Map<string, Map<Element, IHotkeyDescription>>();
// Exposed reactive ref — consumers (HelpPanel) read this to render. Every
// description currently bound to each key, in binding order.
export const boundKeys = ref<Record<string, IHotkeyDescription[]>>({});

// Mousetrap's record plugin only intercepts keys on its global instance,
// and every binding here has its own, so without a pause the key being
// recorded (HotkeySelection) would also run whatever is bound to it.
// Conditions are read at each key press, so a recorder that is hidden but
// still mounted (a closed dialog) stops pausing without having to notice.
const pauseConditions = new Set<() => boolean>();

/** Pause every bound hotkey while `condition()` holds; returns the release. */
export function pauseHotkeysWhile(condition: () => boolean): () => void {
  pauseConditions.add(condition);
  return () => {
    pauseConditions.delete(condition);
  };
}

function hotkeysPaused(): boolean {
  for (const condition of pauseConditions) {
    if (condition()) {
      return true;
    }
  }
  return false;
}

function flush() {
  boundKeys.value = Object.fromEntries(
    [..._raw].map(([key, owners]) => [key, [...owners.values()]]),
  );
}

function bind(el: any, value: IHotkey | IHotkey[], bindElement: any) {
  const mousetrap = new Mousetrap(bindElement ? el : undefined);
  el.mousetrap = mousetrap;
  if (!isArray(value)) {
    value = [value];
  }
  el.mousetrapValues = value;
  const allowedInInputs = new Set(
    value.filter((hotkey) => hotkey.allowInInputs).map((hotkey) => hotkey.bind),
  );
  if (allowedInInputs.size) {
    const defaultStopCallback = mousetrap.stopCallback;
    mousetrap.stopCallback = function (
      this: any,
      event: KeyboardEvent,
      element: Element,
      combo: string,
    ) {
      return allowedInInputs.has(combo)
        ? false
        : defaultStopCallback.call(this, event, element, combo);
    };
  }
  let changed = false;
  value.forEach(({ bind: _bind, handler, disabled, data }: IHotkey) => {
    if (disabled) {
      return;
    }
    mousetrap.bind(_bind, function (this: any, ...args) {
      if (hotkeysPaused()) {
        return;
      }
      handler.apply(this, [el, ...args]);
    });
    if (data) {
      if (!_raw.has(_bind)) {
        _raw.set(_bind, new Map());
      }
      _raw.get(_bind)!.set(el, data);
      changed = true;
    }
  });
  if (changed) {
    flush();
  }
}

function unbind(el: any) {
  el.mousetrap.reset();
  let changed = false;
  el.mousetrapValues.forEach(({ bind: _bind, data }: IHotkey) => {
    const owners = _raw.get(_bind);
    if (data && owners?.delete(el)) {
      if (owners.size === 0) {
        _raw.delete(_bind);
      }
      changed = true;
    }
  });
  if (changed) {
    flush();
  }
}

export const mousetrapDirective = {
  mounted(
    el: any,
    { value, modifiers }: { value: IHotkey | IHotkey[]; modifiers: any },
  ) {
    bind(el, value, modifiers.element);
  },
  updated(
    el: any,
    {
      value,
      oldValue,
      modifiers,
    }: {
      value: IHotkey | IHotkey[];
      oldValue: IHotkey | IHotkey[];
      modifiers: any;
    },
  ) {
    if (value === oldValue) return;
    unbind(el);
    bind(el, value, modifiers.element);
  },
  unmounted(el: any) {
    unbind(el);
  },
};

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
const _raw: Record<string, IHotkeyDescription> = {};
// Exposed reactive ref — consumers (HelpPanel) read this to render.
export const boundKeys = ref<Record<string, IHotkeyDescription>>({});

function flush() {
  boundKeys.value = { ..._raw };
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
      handler.apply(this, [el, ...args]);
    });
    if (data) {
      _raw[_bind] = data;
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
    if (data) {
      delete _raw[_bind];
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

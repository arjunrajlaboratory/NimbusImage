import Mousetrap from "mousetrap";
import { isArray } from "lodash";
import { ref } from "vue";

export interface IHotkey {
  bind: string;
  handler: Function;
  disabled?: boolean;
  data?: IHotkeyDescription;
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

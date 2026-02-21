import { ref } from "vue";

export interface IFeatureDescription {
  section: string;
  title: string;
  description: string;
}

let counter = 0;

// Internal mutable store — not reactive, so directive hooks don't create
// dependency-tracking loops when they run inside a component's render watcher.
const _raw: Record<string, IFeatureDescription> = {};
// Exposed reactive ref — consumers (HelpPanel) read this to render.
export const descriptions = ref<Record<string, IFeatureDescription>>({});

function flush() {
  descriptions.value = { ..._raw };
}

function bind(el: any, value: IFeatureDescription) {
  let id: number;
  if ("featureDescriptionId" in el) {
    id = el.featureDescriptionId;
  } else {
    id = counter++;
    el.featureDescriptionId = id;
  }
  el.featureDescription = value;
  _raw[id] = value;
  flush();
}

function unbind(el: any) {
  const id: number = el.featureDescriptionId;
  delete _raw[id];
  flush();
}

function shallowEqual(
  a: IFeatureDescription,
  b: IFeatureDescription,
): boolean {
  return (
    a === b ||
    (a.section === b.section &&
      a.title === b.title &&
      a.description === b.description)
  );
}

export default function install(Vue: any) {
  Vue.directive("description", {
    inserted(el: any, { value }: { value: IFeatureDescription }) {
      bind(el, value);
    },
    update(
      el: any,
      {
        value,
        oldValue,
      }: { value: IFeatureDescription; oldValue: IFeatureDescription },
    ) {
      if (shallowEqual(value, oldValue)) return;
      unbind(el);
      bind(el, value);
    },
    unbind(el: any) {
      unbind(el);
    },
  });
}

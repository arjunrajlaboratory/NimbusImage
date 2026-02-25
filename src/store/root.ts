import { createStore } from "vuex";

const store = createStore({});

// Make registerModule idempotent for HMR: vuex-module-decorators calls
// store.registerModule() at class-definition time via @Module({ dynamic: true }).
// When Vite re-evaluates a store file during HMR, the decorator re-runs and
// tries to register the same module again, causing "duplicate getter" warnings
// and state overwrites that freeze the browser. Fix: unregister first.
if (import.meta.hot) {
  const origRegister = store.registerModule.bind(store);
  store.registerModule = function (path: any, rawModule: any, options?: any) {
    const name = Array.isArray(path) ? path[0] : path;
    if (name && name in (store.state as Record<string, unknown>)) {
      // Module already exists — re-register with preserveState so Vuex
      // keeps the existing runtime state (loaded dataset, annotations, etc.)
      // while picking up any new/changed getters, actions, and mutations.
      store.unregisterModule(Array.isArray(path) ? path : [path]);
      return origRegister(path, rawModule, {
        ...options,
        preserveState: true,
      });
    }
    return origRegister(path, rawModule, options);
  } as any;
}

export default store;

// Self-accept HMR to prevent cascading to importers.
if (import.meta.hot) {
  import.meta.hot.accept();
}

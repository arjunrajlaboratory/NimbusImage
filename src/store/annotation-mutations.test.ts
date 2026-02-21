/**
 * Tests for annotation store mutation reactivity.
 *
 * Vue 2.7's Composition API watch() uses Object.is() for change detection,
 * unlike Vue 2's @Watch decorator which fires for any object regardless of
 * reference identity. Mutations that use .push() (same array reference) won't
 * trigger watch() callbacks, while mutations that replace the array (new
 * reference) will.
 *
 * These tests verify that connection mutations create new array references
 * so that watch() in <script setup> components detects the change.
 */
import { describe, it, expect, vi } from "vitest";
import Vue from "vue";
import Vuex from "vuex";
import { watch, computed, nextTick } from "vue";

Vue.use(Vuex);

// Minimal mock of the annotation store's connection state and mutations
function createTestStore() {
  return new Vuex.Store({
    state: {
      annotationConnections: [] as any[],
    },
    mutations: {
      // Reproduces the FIXED mutation (array replacement)
      addMultipleConnections(state, connections: any[]) {
        state.annotationConnections = [
          ...state.annotationConnections,
          ...connections,
        ];
      },
      // Reproduces the OLD buggy mutation (in-place push)
      addMultipleConnectionsBuggy(state, connections: any[]) {
        state.annotationConnections.push(...connections);
      },
      addConnectionImpl(state, connection: any) {
        state.annotationConnections = [
          ...state.annotationConnections,
          connection,
        ];
      },
      addConnectionImplBuggy(state, connection: any) {
        state.annotationConnections.push(connection);
      },
    },
  });
}

describe("connection mutation reactivity with Vue 2.7 watch()", () => {
  it("addMultipleConnections creates a new array reference", () => {
    const store = createTestStore();
    const oldRef = store.state.annotationConnections;
    const conn = { id: "c1", parentId: "a1", childId: "a2" };

    store.commit("addMultipleConnections", [conn]);

    expect(store.state.annotationConnections).not.toBe(oldRef);
    expect(store.state.annotationConnections).toHaveLength(1);
    expect(store.state.annotationConnections[0]).toBe(conn);
  });

  it("addConnectionImpl creates a new array reference", () => {
    const store = createTestStore();
    const oldRef = store.state.annotationConnections;
    const conn = { id: "c1", parentId: "a1", childId: "a2" };

    store.commit("addConnectionImpl", conn);

    expect(store.state.annotationConnections).not.toBe(oldRef);
    expect(store.state.annotationConnections).toHaveLength(1);
    expect(store.state.annotationConnections[0]).toBe(conn);
  });

  it("addMultipleConnections preserves existing connections", () => {
    const store = createTestStore();
    const conn1 = { id: "c1", parentId: "a1", childId: "a2" };
    const conn2 = { id: "c2", parentId: "a3", childId: "a4" };

    store.commit("addMultipleConnections", [conn1]);
    store.commit("addMultipleConnections", [conn2]);

    expect(store.state.annotationConnections).toHaveLength(2);
    expect(store.state.annotationConnections[0]).toBe(conn1);
    expect(store.state.annotationConnections[1]).toBe(conn2);
  });

  it("fixed mutation triggers watch() callback", async () => {
    const store = createTestStore();
    const connections = computed(() => store.state.annotationConnections);
    const callback = vi.fn();

    // Mount a temporary component to enable watchers
    const vm = new Vue({
      store,
      setup() {
        watch(connections, callback);
        return {};
      },
      render: (h: any) => h("div"),
    }).$mount();

    store.commit("addMultipleConnections", [
      { id: "c1", parentId: "a1", childId: "a2" },
    ]);

    await nextTick();
    expect(callback).toHaveBeenCalledTimes(1);

    vm.$destroy();
  });

  it("buggy push mutation does NOT trigger watch() callback", async () => {
    const store = createTestStore();
    const connections = computed(() => store.state.annotationConnections);
    const callback = vi.fn();

    const vm = new Vue({
      store,
      setup() {
        watch(connections, callback);
        return {};
      },
      render: (h: any) => h("div"),
    }).$mount();

    store.commit("addMultipleConnectionsBuggy", [
      { id: "c1", parentId: "a1", childId: "a2" },
    ]);

    await nextTick();
    // This demonstrates the bug: push() doesn't trigger watch()
    expect(callback).not.toHaveBeenCalled();

    vm.$destroy();
  });
});

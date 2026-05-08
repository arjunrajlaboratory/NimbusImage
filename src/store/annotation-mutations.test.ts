/**
 * Tests for annotation store mutation reactivity.
 *
 * Vue 3's watch() uses Object.is() for change detection.
 * Mutations that use .push() (same array reference) won't
 * trigger watch() callbacks, while mutations that replace the array (new
 * reference) will.
 *
 * These tests verify that connection mutations create new array references
 * so that watch() in <script setup> components detects the change.
 */
import { describe, it, expect, vi } from "vitest";
import { createStore } from "vuex";
import {
  defineComponent,
  watch,
  computed,
  nextTick,
  h,
  markRaw,
  isReactive,
} from "vue";
import { mount } from "@vue/test-utils";

// Minimal mock of the annotation store's connection state and mutations
function createTestStore() {
  return createStore({
    state() {
      return {
        annotations: [] as any[],
        annotationConnections: [] as any[],
      };
    },
    mutations: {
      addAnnotationImpl(state, annotation: any) {
        const rawAnnotation = markRaw(annotation);
        state.annotations = [...state.annotations, rawAnnotation];
      },
      addAnnotationsImpl(state, annotations: any[]) {
        const rawAnnotations = annotations.map((annotation) =>
          markRaw(annotation),
        );
        state.annotations = [...state.annotations, ...rawAnnotations];
      },
      setAnnotation(state, { annotation, index }: any) {
        const annotations = [...state.annotations];
        annotations[index] = markRaw(annotation);
        state.annotations = annotations;
      },
      setAnnotations(state, annotations: any[]) {
        state.annotations = annotations.map((annotation) =>
          markRaw(annotation),
        );
      },
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

describe("annotation mutation reactivity with raw annotations", () => {
  it("stores annotation objects as raw values", () => {
    const store = createTestStore();
    const annotation = { id: "a1", coordinates: [] };

    store.commit("setAnnotations", [annotation]);

    expect(store.state.annotations[0]).toBe(annotation);
    expect(isReactive(store.state.annotations[0])).toBe(false);
  });

  it("addAnnotationImpl creates a new array reference", () => {
    const store = createTestStore();
    const oldRef = store.state.annotations;
    const annotation = { id: "a1", coordinates: [] };

    store.commit("addAnnotationImpl", annotation);

    expect(store.state.annotations).not.toBe(oldRef);
    expect(store.state.annotations).toHaveLength(1);
    expect(store.state.annotations[0]).toBe(annotation);
    expect(isReactive(store.state.annotations[0])).toBe(false);
  });

  it("addAnnotationsImpl creates one new array with raw values", () => {
    const store = createTestStore();
    const oldRef = store.state.annotations;
    const annotations = [
      { id: "a1", coordinates: [] },
      { id: "a2", coordinates: [] },
    ];

    store.commit("addAnnotationsImpl", annotations);

    expect(store.state.annotations).not.toBe(oldRef);
    expect(store.state.annotations).toStrictEqual(annotations);
    expect(isReactive(store.state.annotations[0])).toBe(false);
    expect(isReactive(store.state.annotations[1])).toBe(false);
  });

  it("setAnnotation creates a new array reference", () => {
    const store = createTestStore();
    const annotation = { id: "a1", color: "red", coordinates: [] };
    store.commit("setAnnotations", [annotation]);
    const oldRef = store.state.annotations;

    const updated = { ...annotation, color: "blue" };
    store.commit("setAnnotation", { annotation: updated, index: 0 });

    expect(store.state.annotations).not.toBe(oldRef);
    expect(store.state.annotations[0]).toBe(updated);
    expect(isReactive(store.state.annotations[0])).toBe(false);
  });

  it("setAnnotation triggers watch() callbacks", async () => {
    const store = createTestStore();
    const callback = vi.fn();
    const annotation = { id: "a1", color: "red", coordinates: [] };
    store.commit("setAnnotations", [annotation]);

    const TestComponent = defineComponent({
      setup() {
        const annotations = computed(() => store.state.annotations);
        watch(annotations, callback);
        return () => h("div");
      },
    });

    mount(TestComponent, {
      global: { plugins: [store] },
    });

    store.commit("setAnnotation", {
      annotation: { ...annotation, color: "blue" },
      index: 0,
    });

    await nextTick();
    expect(callback).toHaveBeenCalledTimes(1);
  });
});

describe("connection mutation reactivity with watch()", () => {
  it("addMultipleConnections creates a new array reference", () => {
    const store = createTestStore();
    const oldRef = store.state.annotationConnections;
    const conn = { id: "c1", parentId: "a1", childId: "a2" };

    store.commit("addMultipleConnections", [conn]);

    expect(store.state.annotationConnections).not.toBe(oldRef);
    expect(store.state.annotationConnections).toHaveLength(1);
    expect(store.state.annotationConnections[0]).toStrictEqual(conn);
  });

  it("addConnectionImpl creates a new array reference", () => {
    const store = createTestStore();
    const oldRef = store.state.annotationConnections;
    const conn = { id: "c1", parentId: "a1", childId: "a2" };

    store.commit("addConnectionImpl", conn);

    expect(store.state.annotationConnections).not.toBe(oldRef);
    expect(store.state.annotationConnections).toHaveLength(1);
    expect(store.state.annotationConnections[0]).toStrictEqual(conn);
  });

  it("addMultipleConnections preserves existing connections", () => {
    const store = createTestStore();
    const conn1 = { id: "c1", parentId: "a1", childId: "a2" };
    const conn2 = { id: "c2", parentId: "a3", childId: "a4" };

    store.commit("addMultipleConnections", [conn1]);
    store.commit("addMultipleConnections", [conn2]);

    expect(store.state.annotationConnections).toHaveLength(2);
    expect(store.state.annotationConnections[0]).toStrictEqual(conn1);
    expect(store.state.annotationConnections[1]).toStrictEqual(conn2);
  });

  it("fixed mutation triggers watch() callback", async () => {
    const store = createTestStore();
    const callback = vi.fn();

    const TestComponent = defineComponent({
      setup() {
        const connections = computed(() => store.state.annotationConnections);
        watch(connections, callback);
        return () => h("div");
      },
    });

    mount(TestComponent, {
      global: { plugins: [store] },
    });

    store.commit("addMultipleConnections", [
      { id: "c1", parentId: "a1", childId: "a2" },
    ]);

    await nextTick();
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("buggy push mutation does NOT trigger watch() callback", async () => {
    const store = createTestStore();
    const callback = vi.fn();

    const TestComponent = defineComponent({
      setup() {
        const connections = computed(() => store.state.annotationConnections);
        watch(connections, callback);
        return () => h("div");
      },
    });

    mount(TestComponent, {
      global: { plugins: [store] },
    });

    store.commit("addMultipleConnectionsBuggy", [
      { id: "c1", parentId: "a1", childId: "a2" },
    ]);

    await nextTick();
    // This demonstrates the bug: push() doesn't trigger watch()
    expect(callback).not.toHaveBeenCalled();
  });
});

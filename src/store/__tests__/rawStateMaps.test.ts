import { describe, it, expect } from "vitest";
import { isReactive, markRaw } from "vue";

import annotationStore from "../annotation";
import store from "../root";
import { IAnnotationStub } from "../model";

/**
 * The big per-annotation maps must never be handed to Vuex un-`markRaw`ed:
 * Vue would walk and proxy every entry, which on a 700K-annotation dataset
 * costs far more than whatever mutation was being performed (measured: it
 * dominated a whole-dataset recolor). A missing markRaw is invisible to tsc,
 * lint, and any small-fixture test — only the size makes it hurt — so assert
 * the invariant directly, for every mutation that replaces one of these maps.
 */
function stub(id: string, color: string | null): IAnnotationStub {
  return {
    id,
    shape: "polygon",
    tags: [],
    channel: 0,
    location: { XY: 0, Z: 0, Time: 0 },
    color,
    centroid: { x: 0, y: 0 },
    estimatedRadius: 1,
  } as unknown as IAnnotationStub;
}

function seed() {
  Object.assign((store.state as any).annotation, {
    annotationStubs: markRaw(
      new Map([
        ["a1", stub("a1", null)],
        ["a2", stub("a2", "#222222")],
      ]),
    ),
    hydratedAnnotations: markRaw(new Map()),
    annotations: [],
    selectedAnnotationIds: [],
  });
}

describe("per-annotation state maps stay non-reactive", () => {
  it("applyColorAssignment leaves annotationStubs raw", () => {
    seed();
    annotationStore.applyColorAssignment([{ color: "#111111", ids: ["a1"] }]);
    expect(isReactive(annotationStore.annotationStubs)).toBe(false);
    // The patch still happened.
    expect(annotationStore.annotationStubs.get("a1")!.color).toBe("#111111");
    expect(annotationStore.annotationStubs.get("a2")!.color).toBeNull();
  });

  it("applyColorAssignment leaves hydratedAnnotations raw", () => {
    seed();
    Object.assign((store.state as any).annotation, {
      hydratedAnnotations: markRaw(
        new Map([["a1", { ...stub("a1", null), coordinates: [] } as any]]),
      ),
    });
    annotationStore.applyColorAssignment([{ color: "#111111", ids: ["a1"] }]);
    expect(isReactive(annotationStore.hydratedAnnotations)).toBe(false);
    expect(annotationStore.hydratedAnnotations.get("a1")!.color).toBe(
      "#111111",
    );
  });

  it("applyStubFieldUpdates leaves both maps raw", () => {
    seed();
    annotationStore.applyStubFieldUpdates([{ id: "a1", color: "#333333" }]);
    expect(isReactive(annotationStore.annotationStubs)).toBe(false);
    expect(isReactive(annotationStore.hydratedAnnotations)).toBe(false);
  });

  it("mergeHydratedAnnotations leaves hydratedAnnotations raw", () => {
    seed();
    annotationStore.mergeHydratedAnnotations({
      newEntries: [
        {
          id: "a1",
          annotation: { ...stub("a1", null), coordinates: [] } as any,
        },
      ],
      touchedIds: [],
    });
    expect(isReactive(annotationStore.hydratedAnnotations)).toBe(false);
  });
});

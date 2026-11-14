import { describe, it, expect, beforeEach } from "vitest";
import lineScanStore, { newLineScanViewerId } from "./lineScan";

const line = [
  { x: 0, y: 0 },
  { x: 10, y: 10 },
];

describe("lineScan viewer ownership", () => {
  let viewerA: number;
  let viewerB: number;

  beforeEach(() => {
    // Leave no viewers registered from an earlier test
    while (lineScanStore.viewerCount > 0) {
      lineScanStore.viewerUnmounted(-1);
    }
    viewerA = newLineScanViewerId();
    viewerB = newLineScanViewerId();
    lineScanStore.viewerMounted();
    lineScanStore.viewerMounted();
    lineScanStore.setToolLineType("segment");
  });

  it("keeps another viewer's line and the tool state when one of several viewers unmounts", () => {
    lineScanStore.setLine({
      points: line,
      isComplete: true,
      ownerViewerId: viewerA,
    });

    lineScanStore.viewerUnmounted(viewerB);

    expect(lineScanStore.points).toEqual(line);
    expect(lineScanStore.isComplete).toBe(true);
    expect(lineScanStore.toolLineType).toBe("segment");
  });

  it("keeps a segment start placed by another viewer when one viewer unmounts", () => {
    lineScanStore.setLine({
      points: [line[0]],
      isComplete: false,
      ownerViewerId: viewerA,
    });
    lineScanStore.setSegmentStartPlaced(true);

    lineScanStore.viewerUnmounted(viewerB);

    expect(lineScanStore.segmentStartPlaced).toBe(true);
    expect(lineScanStore.points).toEqual([line[0]]);
  });

  it("clears the line, but not the tool state, when the viewer that drew it unmounts", () => {
    lineScanStore.setLine({
      points: [line[0]],
      isComplete: false,
      ownerViewerId: viewerA,
    });
    lineScanStore.setSegmentStartPlaced(true);

    lineScanStore.viewerUnmounted(viewerA);

    expect(lineScanStore.points).toBeNull();
    expect(lineScanStore.ownerViewerId).toBeNull();
    expect(lineScanStore.segmentStartPlaced).toBe(false);
    expect(lineScanStore.toolLineType).toBe("segment");
  });

  it("clears everything when the last viewer unmounts", () => {
    lineScanStore.setLine({
      points: line,
      isComplete: true,
      ownerViewerId: viewerA,
    });

    lineScanStore.viewerUnmounted(viewerB);
    lineScanStore.viewerUnmounted(viewerA);

    expect(lineScanStore.viewerCount).toBe(0);
    expect(lineScanStore.points).toBeNull();
    expect(lineScanStore.toolLineType).toBeNull();
  });

  it("forgets the owner when the line is cleared", () => {
    lineScanStore.setLine({
      points: line,
      isComplete: true,
      ownerViewerId: viewerA,
    });

    lineScanStore.clearLine();

    expect(lineScanStore.ownerViewerId).toBeNull();
  });
});

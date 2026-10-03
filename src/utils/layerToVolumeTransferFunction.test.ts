import { describe, expect, it } from "vitest";
import { layerToVolumeTransferFunction } from "@/utils/layerToVolumeTransferFunction";

describe("layerToVolumeTransferFunction", () => {
  it("maps 8-bit scalars from black to the layer color", () => {
    const { colorTransferFunction, opacityTransferFunction } =
      layerToVolumeTransferFunction("#3366cc");

    const blackNode: number[] = [];
    const colorNode: number[] = [];
    colorTransferFunction.getNodeValue(0, blackNode);
    colorTransferFunction.getNodeValue(1, colorNode);

    expect(blackNode.slice(0, 4)).toEqual([0, 0, 0, 0]);
    expect(colorNode[0]).toBe(255);
    expect(colorNode[1]).toBeCloseTo(0.2);
    expect(colorNode[2]).toBeCloseTo(0.4);
    expect(colorNode[3]).toBeCloseTo(0.8);

    const opacityNode: number[] = [];
    opacityTransferFunction.getNodeValue(3, opacityNode);
    expect(opacityNode[0]).toBe(255);
    expect(opacityNode[1]).toBeCloseTo(0.38);
  });
});

import { describe, it, expect } from "vitest";
import {
  IChannelContext,
  normalizeWorkerInterfaceValue,
  WORKER_INTERFACE_VALUE_FORMATS,
} from "@/utils/workerInterface";
import { TWorkerInterfaceElement } from "@/store/model";

// DAPI=0, FITC=1, TRITC=2, Cy5=3 — mirrors the sample HCR dataset.
const ctx: IChannelContext = {
  channels: [0, 1, 2, 3],
  nameToIndex: new Map([
    ["dapi", 0],
    ["fitc", 1],
    ["tritc", 2],
    ["cy5", 3],
  ]),
};

const checkboxes: TWorkerInterfaceElement = {
  type: "channelCheckboxes",
} as TWorkerInterfaceElement;

describe("normalizeWorkerInterfaceValue — channelCheckboxes", () => {
  it("normalizes an array of indices to a full boolean map", () => {
    expect(
      normalizeWorkerInterfaceValue(checkboxes, [0], ctx, "Slot 1"),
    ).toEqual({ 0: true, 1: false, 2: false, 3: false });
  });

  it("resolves channel names to indices", () => {
    expect(
      normalizeWorkerInterfaceValue(checkboxes, ["DAPI"], ctx, "Slot 1"),
    ).toEqual({ 0: true, 1: false, 2: false, 3: false });
  });

  it("accepts a single index number", () => {
    expect(normalizeWorkerInterfaceValue(checkboxes, 2, ctx, "Slot 1")).toEqual(
      { 0: false, 1: false, 2: true, 3: false },
    );
  });

  it("respects a canonical {index: boolean} map", () => {
    expect(
      normalizeWorkerInterfaceValue(
        checkboxes,
        { 0: true, 1: false } as any,
        ctx,
        "Slot 1",
      ),
    ).toEqual({ 0: true, 1: false, 2: false, 3: false });
  });

  it("throws on the classic {index: index} mistake (all falsy)", () => {
    // The bug: model wrote {"0": 0} meaning channel 0, but 0 is falsy.
    expect(() =>
      normalizeWorkerInterfaceValue(checkboxes, { 0: 0 } as any, ctx, "Slot 1"),
    ).toThrow(/no channel is selected/);
  });

  it("allows an explicit empty selection for optional slots", () => {
    expect(
      normalizeWorkerInterfaceValue(checkboxes, [], ctx, "Slot 2"),
    ).toEqual({ 0: false, 1: false, 2: false, 3: false });
  });

  it("throws on an unknown channel index", () => {
    expect(() =>
      normalizeWorkerInterfaceValue(checkboxes, [9], ctx, "Slot 1"),
    ).toThrow(/does not exist/);
  });

  it("throws on an unknown channel name", () => {
    expect(() =>
      normalizeWorkerInterfaceValue(checkboxes, ["GFP"], ctx, "Slot 1"),
    ).toThrow(/unknown channel/);
  });
});

describe("normalizeWorkerInterfaceValue — other types", () => {
  it("resolves a channel name to an index for the channel type", () => {
    const el = { type: "channel", required: true } as TWorkerInterfaceElement;
    expect(normalizeWorkerInterfaceValue(el, "Cy5", ctx, "Channel")).toBe(3);
  });

  it("passes a valid channel index through unchanged", () => {
    const el = { type: "channel" } as TWorkerInterfaceElement;
    expect(normalizeWorkerInterfaceValue(el, 1, ctx, "Channel")).toBe(1);
  });

  it("validates select options", () => {
    const el = {
      type: "select",
      items: ["a", "b"],
    } as TWorkerInterfaceElement;
    expect(normalizeWorkerInterfaceValue(el, "a", ctx, "Model")).toBe("a");
    expect(() => normalizeWorkerInterfaceValue(el, "c", ctx, "Model")).toThrow(
      /not a valid option/,
    );
  });

  it("coerces checkbox values to boolean", () => {
    const el = { type: "checkbox" } as TWorkerInterfaceElement;
    expect(normalizeWorkerInterfaceValue(el, 1 as any, ctx, "Flag")).toBe(true);
  });

  it("rejects a non-numeric number value", () => {
    const el = { type: "number" } as TWorkerInterfaceElement;
    expect(normalizeWorkerInterfaceValue(el, 5, ctx, "Diameter")).toBe(5);
    expect(() =>
      normalizeWorkerInterfaceValue(el, "abc" as any, ctx, "Diameter"),
    ).toThrow(/expected a number/);
  });
});

describe("WORKER_INTERFACE_VALUE_FORMATS", () => {
  it("documents every worker-interface type", () => {
    for (const type of [
      "number",
      "notes",
      "text",
      "tags",
      "layer",
      "select",
      "channel",
      "channelCheckboxes",
      "checkbox",
    ]) {
      expect(WORKER_INTERFACE_VALUE_FORMATS[type as never]).toBeTruthy();
    }
  });
});

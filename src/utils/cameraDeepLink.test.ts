import { describe, it, expect } from "vitest";
import {
  cameraDeepLinkZoom,
  omitCameraDeepLinkQuery,
  parseCameraDeepLink,
  queryAfterCameraDeepLink,
  zoomToShowImageWidth,
} from "./cameraDeepLink";

describe("parseCameraDeepLink", () => {
  it("parses x, y and zoom as numbers", () => {
    expect(parseCameraDeepLink({ x: "120.5", y: "40", zoom: "3.25" })).toEqual({
      x: 120.5,
      y: 40,
      zoom: 3.25,
    });
  });

  it("leaves zoom null when it is absent", () => {
    expect(parseCameraDeepLink({ x: "1", y: "2" })).toEqual({
      x: 1,
      y: 2,
      zoom: null,
    });
  });

  it("ignores an invalid zoom but keeps the point", () => {
    for (const zoom of ["", "abc", "Infinity", "NaN"]) {
      expect(parseCameraDeepLink({ x: "1", y: "2", zoom })).toEqual({
        x: 1,
        y: 2,
        zoom: null,
      });
    }
  });

  it("returns null unless both x and y are finite numbers", () => {
    expect(parseCameraDeepLink(undefined)).toBeNull();
    expect(parseCameraDeepLink({})).toBeNull();
    expect(parseCameraDeepLink({ x: "1" })).toBeNull();
    expect(parseCameraDeepLink({ y: "1" })).toBeNull();
    expect(parseCameraDeepLink({ x: "", y: "1" })).toBeNull();
    expect(parseCameraDeepLink({ x: " ", y: "1" })).toBeNull();
    expect(parseCameraDeepLink({ x: "1", y: "abc" })).toBeNull();
    expect(parseCameraDeepLink({ x: "-Infinity", y: "1" })).toBeNull();
    expect(parseCameraDeepLink({ x: null, y: "1" })).toBeNull();
    expect(parseCameraDeepLink({ x: "null", y: "1" })).toBeNull();
  });

  it("reads the first value of a repeated key", () => {
    expect(parseCameraDeepLink({ x: ["5", "9"], y: "6" })).toEqual({
      x: 5,
      y: 6,
      zoom: null,
    });
  });
});

describe("omitCameraDeepLinkQuery", () => {
  it("drops x, y, zoom and width and keeps everything else", () => {
    const query = {
      x: "1",
      y: "2",
      zoom: "3",
      width: "6",
      xy: "4",
      z: "5",
      layer: "a",
    };
    expect(omitCameraDeepLinkQuery(query)).toEqual({
      xy: "4",
      z: "5",
      layer: "a",
    });
    // The route's query object is not mutated.
    expect(query.x).toBe("1");
  });
});

describe("default zoom", () => {
  it("shows the requested image width across the viewport", () => {
    // 4096 units per screen pixel at zoom 0, 1024 px viewport.
    const zoom = zoomToShowImageWidth(4096, 1024, 512);
    expect((4096 / 2 ** zoom) * 1024).toBeCloseTo(512);
  });

  it("uses the link's own zoom when it has one", () => {
    expect(
      cameraDeepLinkZoom(
        { x: 0, y: 0, zoom: 4 },
        {
          unitsPerPixelAtZoom0: 4096,
          viewportWidth: 1024,
          zoomRange: { min: -2, max: 20 },
        },
      ),
    ).toBe(4);
  });

  it("shows a link's width, and its zoom wins over it", () => {
    const map = {
      unitsPerPixelAtZoom0: 4096,
      viewportWidth: 1024,
      zoomRange: { min: -2, max: 20 },
    };
    const link = parseCameraDeepLink({ x: "1", y: "2", width: "2000" })!;
    expect(link.width).toBe(2000);
    expect(cameraDeepLinkZoom(link, map)).toBeCloseTo(
      zoomToShowImageWidth(4096, 1024, 2000),
    );
    expect(cameraDeepLinkZoom({ ...link, zoom: 4 }, map)).toBe(4);
    // A non-positive width is ignored.
    expect(
      parseCameraDeepLink({ x: "1", y: "2", width: "0" })!.width,
    ).toBeUndefined();
  });

  it("clamps to the map's zoom range", () => {
    const map = {
      unitsPerPixelAtZoom0: 4096,
      viewportWidth: 1024,
      zoomRange: { min: 0, max: 15 },
    };
    expect(cameraDeepLinkZoom({ x: 0, y: 0, zoom: 99 }, map)).toBe(15);
    expect(cameraDeepLinkZoom({ x: 0, y: 0, zoom: -5 }, map)).toBe(0);
    // A hidden (zero-width) viewport asks for -Infinity; clamp it.
    expect(
      cameraDeepLinkZoom(
        { x: 0, y: 0, zoom: null },
        { ...map, viewportWidth: 0 },
      ),
    ).toBe(0);
  });
});

describe("queryAfterCameraDeepLink", () => {
  const target = { x: 1, y: 2, zoom: null, datasetId: "d" };

  it("drops the camera keys once a target stops pending", () => {
    expect(
      queryAfterCameraDeepLink(null, target, { x: "1", y: "2", z: "3" }),
    ).toEqual({ z: "3" });
  });

  it("leaves the URL alone while pending or without camera keys", () => {
    expect(queryAfterCameraDeepLink(target, null, { x: "1" })).toBeNull();
    expect(queryAfterCameraDeepLink(null, null, { x: "1" })).toBeNull();
    expect(queryAfterCameraDeepLink(null, target, { z: "3" })).toBeNull();
  });
});

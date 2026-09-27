#!/usr/bin/env python3
"""Upload region annotations (a GeoJSON FeatureCollection, e.g. a pathologist's
Tumor / Necrosis / Immune-infiltration layer exported from QuPath or shipped
with a 10x dataset) as tagged polygons, ready for the Region statistics dialog.

Each Polygon (or every polygon of a MultiPolygon; outer rings only) becomes one
polygon annotation tagged with its class name (`properties.classification.name`,
else `properties.name`) plus `--tag` (default "region").

Coordinates: `--frame` says what the GeoJSON is drawn in, `--target` which
image the dataset shows. 10x ships these layers in H&E pixels.

    frame        target       transform
    he           he           identity
    he           morphology   alignment M      (H&E px -> morphology px)
    morphology   morphology   identity
    morphology   he           M^-1
    microns      morphology   / pixel_size
    microns      he           / pixel_size, then M^-1

    python xenium_upload_regions.py --geojson annotation.geojson \\
        --dataset $MORPH --frame he --target morphology --alignment he_align.csv
    python xenium_upload_regions.py --geojson annotation.geojson \\
        --dataset $HE --frame he --target he
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

import nimbusimage as ni
from xenium_common import connect, log, read_pixel_size

FRAMES = ("he", "morphology", "microns")
TARGETS = ("morphology", "he")


def class_name(properties: dict) -> str | None:
    classification = properties.get("classification") or {}
    return classification.get("name") or properties.get("name")


def outer_rings(geometry: dict):
    if geometry.get("type") == "Polygon":
        yield geometry["coordinates"][0]
    elif geometry.get("type") == "MultiPolygon":
        for polygon in geometry["coordinates"]:
            yield polygon[0]


def transform_for(frame: str, target: str, alignment: np.ndarray | None,
                  pixel_size: float | None):
    """[K, 2] GeoJSON coordinates -> [K, 2] target pixels."""
    def needs(matrix):
        if matrix is None:
            raise SystemExit(f"--alignment is required for {frame} -> {target}")
        return matrix

    def affine(matrix):
        return lambda xy: (
            matrix @ np.column_stack([xy, np.ones(len(xy))]).T
        ).T[:, :2]

    scale = (lambda xy: xy) if frame != "microns" else (
        lambda xy: xy / pixel_size
    )
    if frame == "he":
        if target == "he":
            return lambda xy: xy
        return affine(needs(alignment))
    # morphology pixels (after scaling microns)
    if target == "morphology":
        return scale
    inverse = affine(np.linalg.inv(needs(alignment)))
    return lambda xy: inverse(scale(xy))


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--geojson", type=Path, required=True)
    parser.add_argument("--dataset", required=True,
                        help="NimbusImage dataset (folder) id")
    parser.add_argument("--frame", choices=FRAMES, required=True)
    parser.add_argument("--target", choices=TARGETS, default="morphology")
    parser.add_argument("--alignment", type=Path, default=None,
                        help="*_he_imagealignment.csv (H&E px -> morphology px)")
    parser.add_argument("--bundle-dir", type=Path, default=None,
                        help="for --frame microns: reads pixel_size")
    parser.add_argument("--tag", default="region")
    args = parser.parse_args()

    alignment = (
        np.loadtxt(args.alignment, delimiter=",") if args.alignment else None
    )
    pixel_size = None
    if args.frame == "microns":
        if args.bundle_dir is None:
            raise SystemExit("--frame microns needs --bundle-dir")
        pixel_size = read_pixel_size(args.bundle_dir)
    to_pixels = transform_for(args.frame, args.target, alignment, pixel_size)

    features = json.loads(args.geojson.read_text())["features"]
    annotations = []
    for feature in features:
        name = class_name(feature.get("properties") or {})
        # Class first: GeoJSON export takes the first tag as the QuPath
        # classification, so a round trip keeps "Tumor", not "region".
        tags = ([name] if name else []) + [args.tag]
        for ring in outer_rings(feature.get("geometry") or {}):
            xy = to_pixels(np.asarray(ring, dtype=np.float64)[:, :2])
            if len(xy) >= 2 and np.allclose(xy[0], xy[-1]):
                xy = xy[:-1]  # GeoJSON rings repeat their first vertex
            if len(xy) < 3:
                continue
            annotations.append(ni.Annotation(
                shape="polygon", tags=tags, channel=0,
                dataset_id=args.dataset,
                coordinates=[{"x": float(x), "y": float(y)} for x, y in xy],
                location=ni.Location(xy=0, z=0, time=0),
            ))
    if not annotations:
        raise SystemExit("no polygons in the GeoJSON")
    created = connect().dataset(args.dataset).annotations.create_many(
        annotations
    )
    classes = sorted({t for a in annotations for t in a.tags} - {args.tag})
    log(f"created {len(created)} region polygons tagged {args.tag!r} "
        f"({', '.join(classes)})")
    return 0


if __name__ == "__main__":
    sys.exit(main())

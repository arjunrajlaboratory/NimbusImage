"""Generate polygon annotations for stub testing.

Configurable annotation count, size, channels, and timepoints.
Each polygon has ~10 vertices circling a centroid with noise.
Centroids placed on a grid with jitter to avoid overlap.

Credentials are read from .env in the project root.
"""

import math
import os
import random
import time
from pathlib import Path

from dotenv import load_dotenv
from nimbusimage._girder import create_client

# Load .env from project root
load_dotenv(Path(__file__).resolve().parent.parent / ".env")

API_URL = os.environ["GIRDER_API_URL"]
USERNAME = os.environ["GIRDER_USERNAME"]
PASSWORD = os.environ["GIRDER_PASSWORD"]

DATASET_ID = "69d3831beb50fee970668b83"

IMAGE_W, IMAGE_H = 1024, 1024
N_PER_CHANNEL = 2778       # ~9x fewer than 25K
N_CHANNELS = 2
N_FRAMES = 20              # doubled from 10
N_VERTICES = 10
RADIUS = 6.0               # 3x larger than original 2.0
RADIUS_NOISE = 1.5          # scaled proportionally
BATCH_SIZE = 5000           # annotations per API call

# Grid: sqrt(2778) ≈ 53, so 53×53 = 2809 >= 2778
GRID_COLS = 53
GRID_ROWS = 53
SPACING_X = IMAGE_W / GRID_COLS  # ~19.3
SPACING_Y = IMAGE_H / GRID_ROWS  # ~19.3
JITTER = 3.0  # centroid jitter (pixels), scaled with spacing


def make_polygon_coords(cx: float, cy: float) -> list[dict]:
    """Generate ~10 vertices around (cx, cy) with noise."""
    coords = []
    for i in range(N_VERTICES):
        angle = 2 * math.pi * i / N_VERTICES
        r = RADIUS + random.uniform(-RADIUS_NOISE, RADIUS_NOISE)
        x = cx + r * math.cos(angle)
        y = cy + r * math.sin(angle)
        coords.append({"x": round(x, 2), "y": round(y, 2)})
    return coords


def generate_centroids() -> list[tuple[float, float]]:
    """Generate grid centroids with jitter, return first N_PER_CHANNEL."""
    centroids = []
    for row in range(GRID_ROWS):
        for col in range(GRID_COLS):
            cx = (col + 0.5) * SPACING_X + random.uniform(-JITTER, JITTER)
            cy = (row + 0.5) * SPACING_Y + random.uniform(-JITTER, JITTER)
            cx = max(RADIUS, min(IMAGE_W - RADIUS, cx))
            cy = max(RADIUS, min(IMAGE_H - RADIUS, cy))
            centroids.append((cx, cy))
            if len(centroids) >= N_PER_CHANNEL:
                return centroids
    return centroids


def make_batch(centroids, channel: int, time_idx: int) -> list[dict]:
    """Build annotation dicts for one channel+frame."""
    annotations = []
    for cx, cy in centroids:
        annotations.append({
            "shape": "polygon",
            "tags": ["test-stub"],
            "channel": channel,
            "location": {"XY": 0, "Z": 0, "Time": time_idx},
            "coordinates": make_polygon_coords(cx, cy),
            "datasetId": DATASET_ID,
        })
    return annotations


def main():
    gc = create_client(
        api_url=API_URL, username=USERNAME, password=PASSWORD
    )
    total = N_PER_CHANNEL * N_CHANNELS * N_FRAMES
    print(f"Authenticated. Generating {total:,} annotations...")
    print(
        f"  {N_PER_CHANNEL:,}/channel, {N_CHANNELS} channels, "
        f"{N_FRAMES} frames, radius={RADIUS}"
    )

    total_created = 0
    t0 = time.time()

    for time_idx in range(N_FRAMES):
        for channel in range(N_CHANNELS):
            centroids = generate_centroids()
            annotations = make_batch(centroids, channel, time_idx)

            for i in range(0, len(annotations), BATCH_SIZE):
                batch = annotations[i:i + BATCH_SIZE]
                gc.post("/upenn_annotation/multiple", json=batch)
                total_created += len(batch)
                elapsed = time.time() - t0
                rate = total_created / elapsed if elapsed > 0 else 0
                print(
                    f"  T={time_idx} Ch={channel}: "
                    f"{total_created:,}/{total:,} "
                    f"({rate:.0f}/s)"
                )

    elapsed = time.time() - t0
    print(
        f"\nDone! Created {total_created:,} annotations "
        f"in {elapsed:.1f}s ({total_created/elapsed:.0f}/s)"
    )


if __name__ == "__main__":
    main()

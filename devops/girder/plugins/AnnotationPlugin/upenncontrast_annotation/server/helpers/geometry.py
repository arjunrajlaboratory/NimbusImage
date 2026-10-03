"""Stable identities for annotation geometry."""

import hashlib
import struct


def geometryHash(coordinates):
    """Return an order-sensitive SHA-256 digest of 2-D coordinate values.

    Packing normalized doubles makes integer and floating representations of
    the same point identical while retaining vertex and record boundaries.
    """
    digest = hashlib.sha256()
    digest.update(struct.pack(">Q", len(coordinates)))
    for point in coordinates:
        digest.update(struct.pack(">dd", float(point["x"]), float(point["y"])))
    return digest.hexdigest()

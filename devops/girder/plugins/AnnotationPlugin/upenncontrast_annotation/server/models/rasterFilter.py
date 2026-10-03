"""Registered filter specs for the annotation raster overview.

Overview tiles are GET image URLs, and the viewer's filters (id lists, gate
definitions) do not fit in a URL. The client POSTs its filter spec once; it is
stored here under a content hash, and tiles carry only the hash. Storing it in
Mongo rather than in process memory keeps a tile answerable by any Girder
process behind a load balancer. Entries are content-addressed (re-registering
the same spec refreshes the same document) and expire after a TTL; each
user keeps at most MAX_RASTER_FILTERS_PER_USER live registrations.

ANNOTATION_RASTER_OVERVIEW.md, "Coupling to the viewer's filters".
"""

import datetime
import hashlib
import json

from bson.objectid import ObjectId
from girder.exceptions import ValidationException
from girder.models.model_base import Model

# Long enough to outlive any open viewer; a stale key only costs a
# re-registration (the client re-registers on a 404).
RASTER_FILTER_TTL_SECONDS = 7 * 24 * 3600
# The spec is stored as one JSON string; Mongo documents stop at 16 MiB.
MAX_RASTER_FILTER_BYTES = 8 * 1024 * 1024
# Live registrations per user; registering past it drops that user's oldest.
# A viewer needs one per open dataset view, so this is far above normal use.
MAX_RASTER_FILTERS_PER_USER = 50


class UnknownRasterFilter(Exception):
    """A filter key that is not registered (expired, evicted, or never
    registered) for the dataset it is used on."""


def rasterFilterKey(datasetId, filters):
    """Content hash of a (dataset, validated filters) pair."""
    canonical = json.dumps(
        {"datasetId": str(datasetId), "filters": filters},
        sort_keys=True, separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode()).hexdigest(), canonical


class RasterFilter(Model):
    def initialize(self):
        self.name = "annotation_raster_filter"
        self.ensureIndex(
            ("created", {"expireAfterSeconds": RASTER_FILTER_TTL_SECONDS})
        )
        self.ensureIndex(([("userId", 1), ("created", -1)], {}))

    def validate(self, document):
        if not isinstance(document.get("datasetId"), ObjectId):
            raise ValidationException("datasetId must be an ObjectId")
        if not isinstance(document.get("filtersJson"), str):
            raise ValidationException("filtersJson must be a string")
        if not isinstance(document.get("userId"), ObjectId):
            raise ValidationException("userId must be an ObjectId")
        if not isinstance(document.get("created"), datetime.datetime):
            raise ValidationException("created must be a datetime")
        return document

    def register(self, datasetId, filters, user):
        """Store ``filters`` (already validated) for ``datasetId`` on behalf
        of ``user`` and return its key. Registering past the user's cap drops
        their oldest registrations. Raises ValueError when the spec is too
        large to store."""
        key, canonical = rasterFilterKey(datasetId, filters)
        if len(canonical) > MAX_RASTER_FILTER_BYTES:
            raise ValueError(
                "filters are too large to apply to the overview (%d bytes, "
                "the limit is %d)" % (len(canonical), MAX_RASTER_FILTER_BYTES)
            )
        userId = user["_id"]
        document = self.validate({
            "datasetId": ObjectId(str(datasetId)),
            "filtersJson": json.dumps(filters),
            "userId": userId,
            "created": datetime.datetime.now(datetime.timezone.utc),
        })
        self.collection.update_one(
            {"_id": key}, {"$set": document}, upsert=True
        )
        stale = [
            doc["_id"] for doc in self.find(
                {"userId": userId},
                sort=[("created", -1), ("_id", -1)],
                offset=MAX_RASTER_FILTERS_PER_USER,
                fields=["_id"],
            )
        ]
        if stale:
            self.removeWithQuery({"_id": {"$in": stale}})
        return key

    def filtersFor(self, key, datasetId):
        """The registered filters for ``key`` on ``datasetId``, or None when
        the key is unknown (expired) or belongs to another dataset."""
        document = self.findOne({"_id": key}, fields=["datasetId",
                                                      "filtersJson"])
        if document is None or document["datasetId"] != ObjectId(
            str(datasetId)
        ):
            return None
        return json.loads(document["filtersJson"])

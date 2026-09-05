import math
import re
import threading
from collections import defaultdict

import fastjsonschema

from bson.objectid import ObjectId
from pymongo import UpdateMany, UpdateOne

from girder import events
from girder.constants import AccessType, SortDir
from girder.exceptions import AccessException, ValidationException
from girder.models.folder import Folder

from girder.utility.acl_mixin import AccessControlMixin

from ..helpers import analysis
from ..helpers.aggregation import AGGREGATION_MAX_TIME_MS
from ..helpers.colormaps import (
    CONTINUOUS_COLORMAPS,
    DEFAULT_COLORMAP,
    DISTINCT_CATEGORICAL_COLORS,
    categoricalColor,
    colormapTable,
)
from ..helpers.fastjsonschema import customJsonSchemaCompile
from ..helpers.geometry import geometryHash
from ..helpers.proxiedModel import ProxiedModel
from ..helpers.tasks import runJobRequest
from ..helpers import valueProviders
from ..helpers.annotationRaster import (
    bumpDatasetRasterVersion,
    bumpGlobalRasterVersion,
)
from .propertyValues import AnnotationPropertyValues

# Ceiling on how many ObjectIds all analysis gates together may push into a
# list query. Each id costs ~20 bytes in a BSON array (12-byte oid + index
# key + type), so 400K is ~8 MB — half of MongoDB's 16 MB command limit,
# leaving room for the rest of the pipeline. Resolving a majority gate as
# `$nin` of its complement (see resolveListGateConstraints) already halves
# the worst case; this is the backstop past that.
MAX_GATE_CONSTRAINT_IDS = 400_000
# One selection-summary request carries a single id clause (the smaller of
# the matched set and its complement), so it can hold more than a gate's
# share of MAX_GATE_CONSTRAINT_IDS; 1M ObjectIds is ~12 MB, under Mongo's
# 16 MB command limit with room for the rest of the pipeline.
MAX_SUMMARY_CONSTRAINT_IDS = 1_000_000

# Ceiling on ids returned by one gate-resolution response, across all plots.
# A single gate legitimately matches most of a large dataset (708K ids is
# ~18 MB of JSON), but the allowed plot count multiplies that: 20 broad
# gates on a 700K dataset is ~14M entries and hundreds of MB, which lands
# on the Girder process and then on the browser parsing it.
MAX_GATE_RESPONSE_IDS = 2_000_000

DEFAULT_AGGREGATE_HINT = {"datasetId": 1, "_id": 1}


class AnnotationSchema:
    coordSchema = {
        "type": "object",
        "properties": {
            "x": {"type": "number"},
            "y": {"type": "number"},
            "z": {"type": "number"},
        },
        "name": "Coordinate",
        "description": "GeoJS point",
        "required": ["x", "y"],
    }

    coordsSchema = {"type": "array", "items": coordSchema, "minItems": 1}

    tagsSchema = {"type": "array", "items": {"type": "string"}}

    locationSchema = {
        "type": "object",
        "properties": {
            "XY": {"type": "integer"},
            "Z": {"type": "integer"},
            "Time": {"type": "integer"},
        },
    }

    shapeSchema = {
        "type": "string",
        "enum": ["point", "line", "polygon", "rectangle"],
    }

    annotationSchema = {
        "$schema": "http://json-schema.org/draft-04/schema",
        "id": "/girder/plugins/upenncontrast_annotation/models/annotation",
        "type": "object",
        "properties": {
            "name": {
                "type": "string",
            },
            "coordinates": coordsSchema,
            "tags": tagsSchema,
            "channel": {"type": "integer"},
            "location": locationSchema,
            "shape": shapeSchema,
            "datasetId": {"type": "objectId"},
            "geometryHash": {"type": "string"},
            "color": {
                "type": ["string", "null"],
            },
        },
        # color is optional (legacy, equivalent to null)
        "required": [
            "coordinates",
            "tags",
            "channel",
            "location",
            "shape",
            "datasetId",
        ],
    }


# AccessControlMixin must precede ProxiedModel so its permission-aware
# find/load methods (e.g. findWithPermissions) take MRO precedence over
# the unchecked methods on the base model.
class Annotation(AccessControlMixin, ProxiedModel):
    """
    Defines a model for storing and handling UPennContrast annotations in the
    database.
    """

    # TODO: write lock
    # TODO: save creatorId, creation and update dates

    # Annotation fields allowed as a sort key (field-type sort).
    _SORTABLE_FIELDS = {"location.XY", "location.Z", "location.Time",
                        "name", "channel", "_id"}

    # Collection joined by the property-value $lookup stages.
    PROPERTY_VALUES_COLLECTION = "annotation_property_values"

    # color-by-property tuning. Quantizing continuous values to 256 levels
    # bounds the number of distinct colors — and therefore the number of
    # Mongo update_many calls — regardless of dataset size.
    CONTINUOUS_COLOR_LEVELS = 256
    # Derived, not chosen: past this many categories the palette would repeat
    # itself, so two categories would render identically with nothing in the
    # legend to distinguish them. A value beyond it is not really categorical
    # (e.g. an id or a continuous measurement).
    MAX_CATEGORIES = DISTINCT_CATEGORICAL_COLORS
    COLOR_WRITE_CHUNK = 50000

    # Default continuous range: the 1st..99th percentile rather than the full
    # extent. Real property distributions are long-tailed — on a 708K-cell
    # dataset, 99% of Area values occupied 14.2% of min..max, so a full-extent
    # ramp put nearly every annotation in the same dark bucket. Values outside
    # the range clamp to the end colors, and the legend carries the true
    # extent (dataMin/dataMax) so it can show that it clipped.
    DEFAULT_PERCENTILE_LOW = 1.0
    DEFAULT_PERCENTILE_HIGH = 99.0

    def __init__(self):
        super().__init__()
        compoundSearchIndex = (
            ('datasetId', SortDir.ASCENDING),
            ('_id', SortDir.ASCENDING)
        )
        self.ensureIndices([(compoundSearchIndex, {}),
                            "name", "datasetId", "channel", "location"])

        # Used by Girder to define what field are used to check permissions
        self.resourceColl = 'folder'
        self.resourceParent = 'datasetId'

        self.schema = AnnotationSchema.annotationSchema

        # The property-values model, for PV-driven list queries. Girder
        # model instances are cached singletons, so this is cheap.
        self._pvModel = AnnotationPropertyValues()
        # saveMany replaces existing rows through removeWithQuery. Suppress
        # that internal removal's broad invalidation in the current thread;
        # saveMany bumps the saved documents' datasets after success.
        self._rasterMutationState = threading.local()

    jsonValidate = staticmethod(
        customJsonSchemaCompile(AnnotationSchema.annotationSchema)
    )

    def _aggregate(self, collection, pipeline, hint=DEFAULT_AGGREGATE_HINT):
        """Run an aggregation with the standard index hint, allowDiskUse, and a
        bounded maxTimeMS. Centralizes those options so every heavy/public
        aggregation is runtime-bounded (see AGGREGATION_MAX_TIME_MS)."""
        return collection.aggregate(
            pipeline,
            hint=hint,
            allowDiskUse=True,
            maxTimeMS=AGGREGATION_MAX_TIME_MS,
        )

    def annotationRemovedEvent(self, event):
        if event.info and event.info["_id"]:
            events.trigger(
                "model.upenn_annotation.removeStringIds", [event.info["_id"]]
            )

    def multipleAnnotationsRemovedEvent(self, event):
        if event.info and len(event.info) > 0:
            annotationStringIds = event.info
            events.trigger(
                "model.upenn_annotation.removeStringIds", annotationStringIds
            )

    def initialize(self):
        self.name = "upenn_annotation"
        events.bind(
            "model.folder.remove",
            "upenn.annotations.clean.orphaned",
            self.cleanOrphaned,
        )
        # Cleaning the database when annotations are removed is done by a
        # custom event: model.upenn_annotation.removeStringIds
        events.bind(
            "model.upenn_annotation.remove",
            "upenn.connections.annotationRemovedEvent",
            self.annotationRemovedEvent,
        )
        events.bind(
            "model.upenn_annotation.removeMultiple",
            "upenn.connections.multipleAnnotationsRemovedEvent",
            self.multipleAnnotationsRemovedEvent,
        )
        self.ensureIndices(["datasetId"])

    def cleanOrphaned(self, event):
        if event.info and event.info["_id"]:
            query = {
                "datasetId": event.info["_id"],
            }
            self.removeWithQuery(query)

    def isDatasetId(self, datasetId):
        folder = Folder().load(datasetId, force=True)
        return (
            folder is not None
            and "meta" in folder
            and folder["meta"].get("subtype", None) == "contrastDataset"
        )

    def validate(self, document):
        return self.validateMultiple([document])[0]

    def save(self, document, validate=True, triggerEvents=True):
        # An annotation belongs to exactly one dataset. The only path that
        # changes datasetId is updateMultiple, which bumps the source
        # dataset itself, so bumping the saved dataset suffices here.
        self._setGeometryHash(document)
        saved = super().save(document, validate, triggerEvents)
        bumpDatasetRasterVersion(saved.get("datasetId"))
        return saved

    def saveMany(self, documents, validate=True, triggerEvents=True):
        for document in documents:
            self._setGeometryHash(document)
        previous = getattr(
            self._rasterMutationState, "suppressRemoveBump", False
        )
        self._rasterMutationState.suppressRemoveBump = True
        try:
            saved = super().saveMany(documents, validate, triggerEvents)
        finally:
            self._rasterMutationState.suppressRemoveBump = previous
        for datasetId in set(
            document.get("datasetId") for document in saved
        ):
            bumpDatasetRasterVersion(datasetId)
        return saved

    @staticmethod
    def _setGeometryHash(document):
        if document.get("shape") in ("polygon", "rectangle"):
            document["geometryHash"] = geometryHash(document["coordinates"])
        else:
            document.pop("geometryHash", None)

    def setGeometryHashes(self, hashes):
        """Backfill derived hashes without replacing annotation documents.

        This is intentionally a bulk update: a migrated dataset can contain
        hundreds of thousands of polygons.  The field is derived metadata and
        does not affect rendering, so no raster-version bump is needed.
        """
        chunk = []
        for annotationId, value in hashes.items():
            chunk.append(UpdateOne(
                {"_id": ObjectId(str(annotationId)),
                 "geometryHash": {"$exists": False},
                 "shape": {"$in": ["polygon", "rectangle"]}},
                {"$set": {"geometryHash": value}},
            ))
            if len(chunk) == 10_000:
                self.collection.bulk_write(chunk, ordered=False)
                chunk = []
        if chunk:
            self.collection.bulk_write(chunk, ordered=False)

    def remove(self, document, **kwargs):
        previous = getattr(
            self._rasterMutationState, "suppressRemoveBump", False
        )
        self._rasterMutationState.suppressRemoveBump = True
        try:
            result = super().remove(document, **kwargs)
        finally:
            self._rasterMutationState.suppressRemoveBump = previous
        bumpDatasetRasterVersion(document.get("datasetId"))
        return result

    def removeWithQuery(self, query):
        result = super().removeWithQuery(query)
        if getattr(
            self._rasterMutationState, "suppressRemoveBump", False
        ):
            return result
        datasetId = query.get("datasetId")
        if isinstance(datasetId, ObjectId):
            bumpDatasetRasterVersion(datasetId)
        else:
            # Bulk-id deletion does not carry dataset ids into the model.
            # A global epoch is the safe no-query fallback.
            bumpGlobalRasterVersion()
        return result

    def validateMultiple(self, annotations):
        # Validate using the schema
        try:
            for annotation in annotations:
                self.jsonValidate(annotation)
        except fastjsonschema.JsonSchemaValueException as exp:
            raise ValidationException(exp)

        # Check if the datasets exist
        datasetIds = set(annotation["datasetId"] for annotation in annotations)

        for datasetId in datasetIds:
            if not self.isDatasetId(datasetId):
                raise ValidationException("Annotation dataset ID is invalid")

        return annotations

    def create(self, annotation):
        annotation.pop('_id', None)
        return self.save(annotation)

    def createMultiple(self, annotations):
        for annotation in annotations:
            annotation.pop('_id', None)
        return self.saveMany(annotations)

    def delete(self, annotation):
        self.remove(annotation)

    def deleteMultiple(self, annotationStringIds):
        events.trigger(
            "model.upenn_annotation.removeMultiple", annotationStringIds
        )
        query = {
            "_id": {
                "$in": [ObjectId(stringId) for stringId in annotationStringIds]
            },
        }
        self.removeWithQuery(query)

    def distinctDatasetIds(self, objectIds):
        """The distinct datasetIds of the given annotation ObjectIds.

        Used by the hydrate/deleteMultiple endpoints to discover which datasets
        the requested annotations belong to so access can be checked against
        those datasets (no id-smuggling escalation). Aggregation is the
        sanctioned use of collection directly; keeping it here keeps the API
        method free of pipeline construction.
        """
        if not objectIds:
            return []
        return [
            doc["_id"]
            for doc in self._aggregate(
                self.collection,
                [
                    {"$match": {"_id": {"$in": list(objectIds)}}},
                    {"$group": {"_id": "$datasetId"}},
                ],
                hint="_id_",
            )
        ]

    def stubs(self, datasetId, shape=None, tags=None):
        """Lightweight stub docs for every annotation in a dataset: centroid +
        estimatedRadius, with the full coordinates dropped. Drives the frontend
        stub/hydration view of large datasets. Returns a cursor.

        Built here (not in the API method) so pipeline construction and the
        runtime-bound _aggregate options live with the other list aggregations.
        """
        match = {"datasetId": datasetId}
        if shape:
            match["shape"] = shape
        if tags:
            match["tags"] = {"$all": tags}

        pipeline = [
            {"$match": match},
            {"$addFields": {
                "centroid": {
                    "x": {"$avg": "$coordinates.x"},
                    "y": {"$avg": "$coordinates.y"},
                },
                # Half the larger bounding-box side. Matches the frontend
                # estimateAnnotationRadius so the stub circle tracks the
                # annotation's footprint; the previous bbox-diagonal/2
                # circumscribed the box and overshot the real size by up to
                # sqrt(2) (a square cell rendered ~41% too large).
                "estimatedRadius": {
                    "$divide": [
                        {"$max": [
                            {"$subtract": [
                                {"$max": "$coordinates.x"},
                                {"$min": "$coordinates.x"},
                            ]},
                            {"$subtract": [
                                {"$max": "$coordinates.y"},
                                {"$min": "$coordinates.y"},
                            ]},
                        ]},
                        2,
                    ]
                },
            }},
            {"$project": {"coordinates": 0}},
        ]
        return self._aggregate(self.collection, pipeline)

    def _buildListMatchStages(self, datasetId, filters):
        """Pipeline stages matching annotation-document fields.

        `filters["tags"]` is a structured object {values: string[],
        exclusive: bool} (validated at the API boundary): tag names live
        only in `values`, and `exclusive` is a mode flag — so a tag
        literally named "exclusive" is handled like any other tag.
        Semantics mirror the client tagCloudFilterFunction:
        inclusive -> $in (has any); exclusive -> exactly that set.
        """
        match = {"datasetId": datasetId}
        if filters.get("shape"):
            match["shape"] = filters["shape"]

        tags = filters.get("tags") or {}
        tagValues = tags.get("values") or []
        if tagValues:
            if tags.get("exclusive"):
                match["tags"] = {"$all": tagValues, "$size": len(tagValues)}
            else:
                match["tags"] = {"$in": tagValues}

        location = filters.get("location")
        if location:
            if location.get("XY") is not None:
                match["location.XY"] = location["XY"]
            if location.get("Z") is not None:
                match["location.Z"] = location["Z"]
            if location.get("Time") is not None:
                match["location.Time"] = location["Time"]

        # Each id constraint is an _id $in set; the annotation must match
        # ALL of them (AND of $in's). Mirrors the client selectionFilter
        # and annotationIdFilters membership semantics. Ids are already
        # ObjectId-converted at the API boundary (_validateListInputs).
        idConstraints = filters.get("idConstraints")
        andClauses = [
            {"_id": {"$in": list(ids)}} for ids in (idConstraints or [])
        ]
        # Server-resolved analysis gates arrive as ready-made clauses because
        # a majority gate is expressed as `$nin` of its complement rather
        # than `$in` of its matches (see resolveListGateConstraints).
        andClauses += filters.get("gateMatchClauses") or []
        if andClauses:
            match["$and"] = andClauses

        stages = [{"$match": match}]

        idSubstring = filters.get("idSubstring")
        if idSubstring:
            # Literal substring match (mirrors the client's String.includes);
            # escape so user-supplied regex metacharacters are matched
            # literally rather than interpreted.
            stages.append({"$match": {"$expr": {"$regexMatch": {
                "input": {"$toString": "$_id"},
                "regex": re.escape(idSubstring),
            }}}})
        return stages

    def listIds(self, datasetId, filters):
        """All annotation _ids (as strings) matching the filters."""
        if (filters.get("propertyFilters")
                and not self._hasAnnotationFieldFilters(filters)):
            # PV-driven: matching property-value docs carry the annotationId.
            pipeline = [{"$match": {"datasetId": datasetId}}]
            pipeline += self._propertyFilterStages(
                filters, valueBase="values.")
            pipeline.append({"$project": {"annotationId": 1, "_id": 0}})
            cursor = self._aggregate(self._pvModel.collection, pipeline)
            return [str(doc["annotationId"]) for doc in cursor]

        pipeline = self._annotationDrivenStages(datasetId, filters)
        pipeline.append({"$project": {"_id": 1}})
        cursor = self._aggregate(self.collection, pipeline)
        return [str(doc["_id"]) for doc in cursor]

    def _analysisData(self, datasetId, axes):
        """(docs, valuesById) for the analysis endpoints, from at most two
        projected scans regardless of how many plots share them: one over the
        annotation collection (always — annotation docs anchor existence, so
        an orphaned property-value doc can never produce an id) and one over
        the property-values collection when any axis is a property axis.
        """
        propertyPaths = {}
        virtualPaths = {}
        categoricalKeys = set()
        for axis in axes:
            if axis["type"] != "property":
                categoricalKeys.add(axis["key"])
            elif valueProviders.isVirtualPath(axis["path"]):
                virtualPaths[".".join(axis["path"])] = axis["path"]
            else:
                propertyPaths[".".join(axis["path"])] = axis["path"]

        fields = {"_id": 1}
        if "tags" in categoricalKeys:
            fields["tags"] = 1
        if "shape" in categoricalKeys:
            fields["shape"] = 1
        if "channel" in categoricalKeys:
            fields["channel"] = 1
        if categoricalKeys & {"xy", "z", "time"}:
            fields["location"] = 1
        docs = []
        cursor = self._aggregate(
            self.collection,
            [{"$match": {"datasetId": datasetId}}, {"$project": fields}],
        )
        for doc in cursor:
            doc["id"] = str(doc.pop("_id"))
            docs.append(doc)

        valuesById = {}
        if propertyPaths:
            pvFields = {"_id": 0, "annotationId": 1}
            for path in propertyPaths.values():
                pvFields["values." + ".".join(path)] = 1
            pvCursor = self._aggregate(
                self._pvModel.collection,
                [
                    {"$match": {"datasetId": datasetId}},
                    {"$project": pvFields},
                ],
            )
            for doc in pvCursor:
                valuesById[str(doc["annotationId"])] = (
                    doc.get("values") or {}
                )
        # Virtual axes (valueProviders): the provider's dense answer is nested
        # under the same {prefix: {sub: value}} shape the pure helpers read,
        # so a gene axis and a property axis are indistinguishable downstream.
        for path in virtualPaths.values():
            provider = valueProviders.providerFor(path)
            for annotationId, value in provider.values(
                datasetId, path
            ).items():
                valueProviders.nestValue(
                    valuesById.setdefault(annotationId, {}), path, value
                )
        return docs, valuesById

    def resolveProviderFilters(self, datasetId, filters):
        """Turn property filters on VIRTUAL paths (valueProviders) into
        `gateMatchClauses`, in place, leaving the stored-path filters for the
        Mongo pipelines. Same treatment as gate definitions: the provider
        resolves the predicate to an id set once per request, and the clause
        is the smaller of the set and its complement (_idSelector). A filter
        matching nothing becomes a match-none clause, deliberately."""
        propertyFilters = filters.get("propertyFilters")
        if not propertyFilters:
            return filters
        stored = []
        for propertyFilter in propertyFilters:
            provider = valueProviders.providerFor(propertyFilter["path"])
            if provider is None:
                stored.append(propertyFilter)
                continue
            matching = [
                ObjectId(i) for i in provider.matchingIds(
                    datasetId, propertyFilter["path"], propertyFilter
                )
            ]
            selector = self._idSelector(datasetId, matching)
            if selector is None:
                continue  # every annotation matches: no constraint
            filters.setdefault("gateMatchClauses", []).append(
                {"_id": selector}
            )
        if stored:
            filters["propertyFilters"] = stored
        else:
            del filters["propertyFilters"]
        return filters

    def _fillVirtualValues(self, datasetId, rows, propertyPaths):
        """Add the virtual-path values to page rows (list of documents with
        an `_id`), one provider call per path for the whole page."""
        _, virtualPaths = valueProviders.splitPaths(propertyPaths or [])
        if not virtualPaths:
            return rows
        rows = list(rows)
        annotationIds = [str(row["_id"]) for row in rows]
        for path in virtualPaths:
            provider = valueProviders.providerFor(path)
            values = provider.valuesForIds(datasetId, path, annotationIds)
            for row, value in zip(rows, values):
                if value is not None:
                    valueProviders.nestValue(
                        row.setdefault("values", {}), path, value
                    )
        return rows

    def resolveListGateConstraints(self, datasetId, filters):
        """Convert `filters['analysisGates']` (gate DEFINITIONS, validated at
        the API boundary) into `idConstraints` entries, in place.

        Called once per request, before the paged/count/ids pipelines, so a
        page+count pair never resolves the same gate twice. A gate matching
        nothing becomes an empty $in — zero rows, deliberately not an error
        (unlike a client-sent empty idConstraints entry, which validation
        rejects because the client already knows that answer).
        """
        gates = filters.pop("analysisGates", None)
        if not gates:
            return filters
        axes = [
            axis for gate in gates for axis in (gate["xAxis"], gate["yAxis"])
        ]
        docs, valuesById = self._analysisData(datasetId, axes)
        allIds = [doc["id"] for doc in docs]
        clauses = filters.setdefault("gateMatchClauses", [])
        budget = 0
        for gate in gates:
            ids = analysis.resolve_gate_ids(docs, valuesById, gate)
            complementSize = len(allIds) - len(ids)
            if complementSize * 2 <= len(ids):
                # The gate keeps at least twice what it drops. Inside a
                # pipeline already scoped to this dataset, excluding the
                # complement is equivalent to including the matches and is
                # much smaller.
                #
                # The 2x threshold is measured, not merely "whichever array
                # is shorter": per element `$nin` costs ~1.4x what `$in`
                # does, so a marginally-smaller complement is a LOSS. On the
                # 708,983-object dataset (count via aggregate, warm):
                #
                #   gate keeps   $in      $nin     ratio   winner
                #   51%          566ms    746ms    0.96    $in
                #   60%          648ms    617ms    0.67    $nin
                #   75%          794ms    411ms    0.33    $nin
                #   95%        1,228ms    172ms    0.05    $nin  (7x, and
                #                                    13.5MB -> 0.7MB)
                #
                # Crossover sits near 0.67; 0.5 keeps us clear of it while
                # still capturing the case this exists for.
                keep, operator = complementSize, "$nin"
            else:
                keep, operator = len(ids), "$in"
            # Budget checked BEFORE converting and retaining, not after.
            # Checking at the end still materialized every gate's ObjectIds
            # first: the allowed 20 gates on a 700K dataset can each keep
            # ~350K ids, so the guard against exhausting memory would hold
            # ~7M ObjectIds on its way to returning the 400.
            budget += keep
            if budget > MAX_GATE_CONSTRAINT_IDS:
                # Even the smaller side of every gate can overflow MongoDB's
                # 16 MB command limit on a large enough dataset. Fail with a
                # comprehensible message instead of an opaque BSON error. The
                # real remedy is to push the gate predicate into the query
                # rather than materializing ids — see SERVER_GATING.md.
                filters.pop("gateMatchClauses", None)
                # Says "redraw or disable a gate", NOT "narrow the filters".
                # A gate is a pure predicate resolved over the WHOLE dataset
                # before any tag/property/frame filter applies, so narrowing
                # those cannot change this count by one id — the advice sent
                # the user round a loop that kept returning the same 400.
                raise ValueError(
                    "analysis gates resolve to more than the %d ids the "
                    "list query can carry. Gates are resolved over the whole "
                    "dataset, so other filters will not reduce this: redraw "
                    "a gate to cover fewer objects, or disable one."
                    % MAX_GATE_CONSTRAINT_IDS
                )
            if operator == "$nin":
                matched = set(ids)
                selected = [
                    ObjectId(i) for i in allIds if i not in matched
                ]
            else:
                selected = [ObjectId(i) for i in ids]
            clauses.append({"_id": {operator: selected}})
        return filters

    def resolveAnalysisGates(self, datasetId, plots):
        """Resolve each plot's gate polygon to matching annotation ids.

        Each answer is the PURE per-annotation predicate over the whole
        dataset — independent of every other plot and of any filter state
        (SERVER_GATING.md, "a gate is a pure predicate"). Returns
        {plotId: [id string, ...]}.
        """
        if not plots:
            return {}
        axes = [
            axis for plot in plots for axis in (plot["xAxis"], plot["yAxis"])
        ]
        docs, valuesById = self._analysisData(datasetId, axes)
        resolved = {}
        total = 0
        for plot in plots:
            ids = analysis.resolve_gate_ids(docs, valuesById, plot)
            total += len(ids)
            if total > MAX_GATE_RESPONSE_IDS:
                # Checked as it accumulates, for the same reason the list
                # budget is: the guard must not first build the thing it
                # exists to prevent.
                # "remove a plot", NOT "disable a gate" — unlike the list
                # path, which is fed activeAnalysisGateDefinitions (enabled
                # only), this endpoint receives analysisRefreshScope's
                # resolutionPlots, which deliberately includes DISABLED drawn
                # gates while the panel is open so their counts can be shown.
                # Unchecking the box therefore leaves this request identical
                # and the retry fails the same way.
                raise ValueError(
                    "analysis gates resolve to more than the %d ids one "
                    "response can carry. Gates are resolved over the whole "
                    "dataset, so other filters will not reduce this: redraw "
                    "a gate to cover fewer objects, or remove a plot."
                    % MAX_GATE_RESPONSE_IDS
                )
            resolved[plot["id"]] = ids
        return resolved

    def analysisHistogram(self, datasetId, spec):
        """Binned 2D counts for one plot, display only (SERVER_GATING.md,
        Phase 2): the population is the dataset narrowed by the serializable
        `filters` (the list-endpoint schema) and by the upstream plots'
        gates, so the picture matches what reaches the plot.
        """
        axes = [spec["xAxis"], spec["yAxis"]]
        for upstream in spec["upstreamGates"]:
            axes += [upstream["xAxis"], upstream["yAxis"]]
        docs, valuesById = self._analysisData(datasetId, axes)
        if spec["filters"]:
            passing = set(self.listIds(datasetId, spec["filters"]))
            docs = [doc for doc in docs if doc["id"] in passing]
        for upstream in spec["upstreamGates"]:
            inside = set(
                analysis.resolve_gate_ids(docs, valuesById, upstream)
            )
            docs = [doc for doc in docs if doc["id"] in inside]
        return analysis.histogram2d(docs, valuesById, spec)

    def _centroidAddFields(self):
        return {"$addFields": {"centroid": {
            "x": {"$avg": "$coordinates.x"},
            "y": {"$avg": "$coordinates.y"},
        }}}

    def _lookupStages(self):
        return [
            {"$lookup": {
                "from": self.PROPERTY_VALUES_COLLECTION,
                "localField": "_id",
                "foreignField": "annotationId",
                "as": "_pv",
            }},
            {"$unwind": {
                "path": "$_pv", "preserveNullAndEmptyArrays": True,
            }},
        ]

    def _valuesExpr(self, propertyPaths, valueBase="_pv.values."):
        """Nested `values` projection expression. $$REMOVE drops a missing
        leaf so the nested structure is preserved without nulls."""
        valuesExpr = {}
        for path in propertyPaths:
            ref = "$" + valueBase + ".".join(path)
            node = valuesExpr
            for key in path[:-1]:
                node = node.setdefault(key, {})
            node[path[-1]] = {"$ifNull": [ref, "$$REMOVE"]}
        return valuesExpr

    def _propertyFilterStages(self, filters, valueBase="_pv.values."):
        stages = []
        for propertyFilter in filters.get("propertyFilters") or []:
            valueKey = valueBase + ".".join(propertyFilter["path"])
            if propertyFilter.get("mode") == "values":
                values = propertyFilter.get("values") or []
                if values:
                    stages.append({"$match": {valueKey: {"$in": values}}})
            else:  # range
                cond = {}
                if propertyFilter.get("min") is not None:
                    cond["$gte"] = propertyFilter["min"]
                if propertyFilter.get("max") is not None:
                    cond["$lte"] = propertyFilter["max"]
                if cond:
                    stages.append({"$match": {valueKey: cond}})
        return stages

    def _projectStage(self, propertyPaths):
        project = {"coordinates": 0, "_pv": 0, "_sortValue": 0,
                   "_hasSortValue": 0}
        stages = []
        if propertyPaths:
            stages.append({"$addFields": {
                "values": self._valuesExpr(propertyPaths),
            }})
        stages.append({"$project": project})
        return stages

    def _propertySortAddFields(self, sort, valueBase="_pv.values."):
        # For a property sort, copy the sort key into _sortValue and set
        # _hasSortValue to 1 when the annotation actually has that value.
        # $ifNull maps a *missing* field to null, so the single $ne-null
        # test catches both "field absent" and "field null". _sortStage
        # then sorts _hasSortValue descending first, which keeps
        # annotations lacking the property at the end regardless of the
        # requested sort direction.
        if sort and sort.get("type") == "property":
            ref = "$" + valueBase + ".".join(sort["key"])
            return [{"$addFields": {
                "_sortValue": ref,
                "_hasSortValue": {"$cond": [
                    {"$ne": [{"$ifNull": [ref, None]}, None]}, 1, 0,
                ]},
            }}]
        return []

    def _sortStage(self, sort):
        direction = -1 if (sort or {}).get("order") == "desc" else 1
        if sort and sort.get("type") == "property":
            # _hasSortValue desc puts present-values first (so missing
            # always lands last regardless of direction).
            return {"$sort": {
                "_hasSortValue": -1, "_sortValue": direction, "_id": 1,
            }}
        if sort and sort.get("type") == "field":
            key = sort.get("key")
            if key not in self._SORTABLE_FIELDS:
                raise ValueError("Invalid sort field: %s" % key)
            if key == "_id":
                return {"$sort": {"_id": direction}}
            return {"$sort": {key: direction, "_id": 1}}
        return {"$sort": {"_id": 1}}

    def narrowsPopulation(self, filters):
        """True when a list-filter object constrains the dataset at all —
        annotation-document fields, id constraints, resolved gate clauses,
        or property filters. The one place other plugins should ask this,
        rather than mirroring the field list."""
        return bool(filters.get("propertyFilters")) or \
            self._hasAnnotationFieldFilters(filters)

    def _hasAnnotationFieldFilters(self, filters):
        """True if any filter constrains annotation-document fields.

        The property-values collection carries only datasetId/annotationId/
        values, so when such a filter is present the PV-driven path cannot
        apply and we fall back to the annotation-driven pipeline.
        """
        if filters.get("shape"):
            return True
        if (filters.get("tags") or {}).get("values"):
            return True
        location = filters.get("location") or {}
        if any(location.get(k) is not None for k in ("XY", "Z", "Time")):
            return True
        if filters.get("idConstraints"):
            return True
        # Server-resolved gate clauses are `_id` constraints too, just in a
        # different representation (see resolveListGateConstraints). Omitting
        # them here sent a gate + property-filter query down the PV-driven
        # path, where an `_id` clause on the annotation collection is never
        # applied — the gate silently stopped filtering.
        if filters.get("gateMatchClauses"):
            return True
        if filters.get("idSubstring"):
            return True
        return False

    def _canDrivePvPage(self, filters, sort):
        """Whether listPage can be driven from the property-values
        collection: no annotation-field filters, and not a field sort (which
        would require ordering by annotation fields the PV docs lack)."""
        if self._hasAnnotationFieldFilters(filters):
            return False
        if sort and sort.get("type") == "field":
            return False
        return True

    def _pvSortStage(self, sort):
        # PV-driven: tie-break on annotationId (== the annotation _id), which
        # reproduces the annotation-driven _id tie-break exactly.
        direction = -1 if (sort or {}).get("order") == "desc" else 1
        if sort and sort.get("type") == "property":
            return {"$sort": {
                "_hasSortValue": -1, "_sortValue": direction,
                "annotationId": 1,
            }}
        return {"$sort": {"annotationId": 1}}

    def _pvDrivenPagePipeline(self, datasetId, filters, sort, propertyPaths,
                              skip, limit, restrictToPresentSortValue=False):
        # Sort/paginate the lean property-value docs first, then join the
        # annotation back for just the page and reshape to the
        # annotation-driven output (annotation _id + centroid + values).
        pipeline = [{"$match": {"datasetId": datasetId}}]
        pipeline += self._propertyFilterStages(filters, valueBase="values.")
        # On a pure property sort, paginate only docs that actually have the
        # sort key here; the missing-value annotations are appended exactly
        # once via the no-value tail in _pvDrivenPage. Without this restriction
        # a PV doc that exists but lacks the sort key (_hasSortValue == 0) is
        # returned both here AND by the tail (which matches _pv.values.<key>
        # == None) — duplicating that row and dropping another missing row.
        if restrictToPresentSortValue and sort and sort.get("key"):
            valueKey = "values." + ".".join(sort["key"])
            pipeline.append({"$match": {valueKey: {"$ne": None}}})
        pipeline += self._propertySortAddFields(sort, valueBase="values.")
        pipeline.append(self._pvSortStage(sort))
        pipeline.append({"$skip": skip})
        pipeline.append({"$limit": limit})
        pipeline.append({"$lookup": {
            "from": self.name,
            "localField": "annotationId",
            "foreignField": "_id",
            "as": "_ann",
        }})
        # Non-preserving unwind drops any property-value doc whose annotation
        # is gone (matching the annotation-driven path, which never sees them).
        pipeline.append({"$unwind": "$_ann"})
        if propertyPaths:
            pipeline.append({"$addFields": {
                "_ann.values": self._valuesExpr(propertyPaths,
                                                valueBase="values."),
            }})
        pipeline.append({"$addFields": {"_ann.centroid": {
            "x": {"$avg": "$_ann.coordinates.x"},
            "y": {"$avg": "$_ann.coordinates.y"},
        }}})
        pipeline.append({"$replaceRoot": {"newRoot": "$_ann"}})
        pipeline.append({"$project": {"coordinates": 0}})
        return pipeline

    def _pvHasValueCount(self, datasetId, sort):
        valueKey = "values." + ".".join(sort["key"])
        pipeline = [
            {"$match": {"datasetId": datasetId, valueKey: {"$ne": None}}},
            {"$count": "count"},
        ]
        result = list(self._aggregate(self._pvModel.collection, pipeline))
        return result[0]["count"] if result else 0

    def _noValueTail(self, datasetId, sort, propertyPaths,
                     tailOffset, tailLimit):
        # Annotations with no value for the sort key (missing PV doc or
        # missing path) sort last on a pure property sort. {key: None} matches
        # both missing and null, including when the joined _pv is absent.
        if tailLimit <= 0:
            return []
        sortKey = "_pv.values." + ".".join(sort["key"])
        pipeline = [{"$match": {"datasetId": datasetId}}]
        pipeline += self._lookupStages()
        pipeline.append({"$match": {sortKey: None}})
        pipeline.append({"$sort": {"_id": 1}})
        pipeline.append({"$skip": tailOffset})
        pipeline.append({"$limit": tailLimit})
        pipeline.append(self._centroidAddFields())
        pipeline += self._projectStage(propertyPaths)
        return list(self._aggregate(self.collection, pipeline))

    def _pvDrivenPage(self, datasetId, filters, sort, propertyPaths,
                      skip, limit):
        # A pure property sort (no property filter) must also surface
        # annotations with no value for the sort key, ordered after the
        # present ones. A property filter already excludes those rows.
        isPureSort = (
            bool(sort and sort.get("type") == "property")
            and not filters.get("propertyFilters")
        )
        rows = list(self._aggregate(
            self._pvModel.collection,
            self._pvDrivenPagePipeline(
                datasetId, filters, sort, propertyPaths, skip, limit,
                restrictToPresentSortValue=isPureSort,
            ),
        ))
        if isPureSort and len(rows) < limit:
            hasCount = self._pvHasValueCount(datasetId, sort)
            rows += self._noValueTail(
                datasetId, sort, propertyPaths,
                max(0, skip - hasCount), limit - len(rows),
            )
        return rows

    def listCount(self, datasetId, filters):
        # Sorting never changes the count, so only a property FILTER matters.
        if (filters.get("propertyFilters")
                and not self._hasAnnotationFieldFilters(filters)):
            # PV-driven: count the matching property-value docs, but join back
            # to the annotation with a NON-preserving unwind so an orphaned
            # value doc (whose annotation no longer exists) is excluded -- the
            # page pipeline drops those too, so counting them would inflate
            # `total` above the returnable rows. The join is over
            # the already property-filtered set, not the whole dataset.
            pipeline = [{"$match": {"datasetId": datasetId}}]
            pipeline += self._propertyFilterStages(
                filters, valueBase="values.")
            pipeline.append({"$lookup": {
                "from": self.name,
                "localField": "annotationId",
                "foreignField": "_id",
                "as": "_ann",
            }})
            pipeline.append({"$unwind": "$_ann"})
            pipeline.append({"$count": "n"})
            result = list(self._aggregate(self._pvModel.collection, pipeline))
            return result[0]["n"] if result else 0

        pipeline = self._annotationDrivenStages(datasetId, filters)
        pipeline.append({"$count": "n"})
        result = list(self._aggregate(self.collection, pipeline))
        return result[0]["n"] if result else 0

    def summarize(self, datasetId, filters, propertyPaths):
        """Aggregate statistics over the annotations matching `filters`.

        Returns {total, tags: [{tag, count}] (count desc, then tag), and
        properties: [{path, count, mean, std, min, max}]} — one entry per
        requested path, in request order. `count` is the number of matching
        annotations holding a NUMERIC value at the path; non-numeric, NaN
        and missing values are skipped, matching the analysis axes' reading
        of a property value (Infinity is a number and is kept). `std` is the
        sample standard deviation (null below two values).

        The matching id set is resolved at most once, and the id clause
        both aggregations share is the SMALLER of the matched set and its
        complement (`_idSelector`), as the gate resolver does: a broad
        filter that keeps most of a 700K dataset would otherwise ship a
        dataset-sized `$in` twice. Annotation-field-only filters skip the
        property-value join, so the tag facet runs on them directly and only
        the statistics need the ids.

        Without any filter the statistics run over every property-value
        document of the dataset, so a value document orphaned by a deleted
        annotation counts until the removal hook cleans it (excluding them
        would cost a second full scan per request).
        """
        selector = None
        matchingIds = None
        facetFilters = filters
        if filters.get("propertyFilters"):
            matchingIds = self._matchingObjectIds(datasetId, filters)
            selector = self._idSelector(datasetId, matchingIds)
            facetFilters = (
                {"gateMatchClauses": [{"_id": selector}]} if selector else {}
            )
        elif self._hasAnnotationFieldFilters(filters):
            matchingIds = self._matchingObjectIds(datasetId, filters)
            selector = self._idSelector(datasetId, matchingIds)

        pipeline = self._buildListMatchStages(datasetId, facetFilters)
        pipeline.append({"$facet": {
            "total": [{"$count": "count"}],
            "tags": [
                {"$unwind": "$tags"},
                {"$group": {"_id": "$tags", "count": {"$sum": 1}}},
                {"$sort": {"count": -1, "_id": 1}},
            ],
        }})
        facets = next(self._aggregate(self.collection, pipeline))
        total = facets["total"][0]["count"] if facets["total"] else 0
        return {
            "total": total,
            "tags": [
                {"tag": doc["_id"], "count": doc["count"]}
                for doc in facets["tags"]
            ],
            "properties": self._propertyStats(
                datasetId, selector, matchingIds, propertyPaths, total
            ),
        }

    def _matchingObjectIds(self, datasetId, filters):
        """ObjectIds of the annotations matching `filters`; the same two
        pipelines as listIds, without the string round trip."""
        if (filters.get("propertyFilters")
                and not self._hasAnnotationFieldFilters(filters)):
            pipeline = [{"$match": {"datasetId": datasetId}}]
            pipeline += self._propertyFilterStages(
                filters, valueBase="values.")
            pipeline.append({"$project": {"annotationId": 1, "_id": 0}})
            return [
                doc["annotationId"]
                for doc in self._aggregate(self._pvModel.collection, pipeline)
            ]
        pipeline = self._annotationDrivenStages(datasetId, filters)
        pipeline.append({"$project": {"_id": 1}})
        return [
            doc["_id"] for doc in self._aggregate(self.collection, pipeline)
        ]

    def _idSelector(self, datasetId, matchingIds):
        """The cheaper id clause for `matchingIds` within this dataset:
        `{"$in": matched}` or `{"$nin": complement}`, or None when every
        annotation matches (no clause needed).

        Same 2x rule as resolveListGateConstraints, whose measurements it
        relies on: `$nin` costs ~1.4x per element, so the complement only
        wins once it is at most half the matched set.
        """
        counted = list(self._aggregate(self.collection, [
            {"$match": {"datasetId": datasetId}}, {"$count": "count"},
        ]))
        datasetSize = counted[0]["count"] if counted else 0
        # A provider can lag polygon edits, so its ids are not necessarily a
        # subset of the current annotation collection. Intersect before using
        # cardinality to choose "all" or a complement; otherwise one orphaned
        # row plus one newly added cell can turn a real constraint into none.
        matchingIds = list(set(matchingIds))
        liveMatches = [
            document["_id"]
            for document in self._aggregate(self.collection, [
                {"$match": {
                    "datasetId": datasetId,
                    "_id": {"$in": matchingIds},
                }},
                {"$project": {"_id": 1}},
            ])
        ] if matchingIds else []
        complementSize = datasetSize - len(liveMatches)
        if complementSize <= 0:
            return None
        if complementSize * 2 <= len(liveMatches):
            matched = set(liveMatches)
            complement = [
                doc["_id"]
                for doc in self._aggregate(self.collection, [
                    {"$match": {"datasetId": datasetId}},
                    {"$project": {"_id": 1}},
                ])
                if doc["_id"] not in matched
            ]
            operator, selected = "$nin", complement
        else:
            operator, selected = "$in", liveMatches
        if len(selected) > MAX_SUMMARY_CONSTRAINT_IDS:
            raise ValueError(
                "the filters match a set the summary query cannot carry "
                "(more than %d ids on either side); narrow the filters or "
                "summarize the whole dataset" % MAX_SUMMARY_CONSTRAINT_IDS
            )
        return {operator: selected}

    def _propertyStats(self, datasetId, selector, matchingIds, propertyPaths,
                       total):
        """Per-path statistics over the property values of the annotations
        `selector` picks (an `$in`/`$nin` clause from _idSelector; None =
        every annotation in the dataset). Virtual paths (valueProviders) are
        computed in numpy from the provider's dense answer, restricted to
        `matchingIds` (the same set the selector expresses)."""
        empty = {"count": 0, "mean": None, "std": None,
                 "min": None, "max": None}
        if not propertyPaths or total == 0:
            return [{"path": path, **empty} for path in propertyPaths]

        statsByKey = {}
        storedPaths, virtualPaths = valueProviders.splitPaths(propertyPaths)
        if virtualPaths:
            selected = (
                None if matchingIds is None
                else {str(i) for i in matchingIds}
            )
            for path in virtualPaths:
                values = valueProviders.providerFor(path).values(
                    datasetId, path
                )
                statsByKey[".".join(path)] = analysis.describe_values(
                    value for annotationId, value in values.items()
                    if selected is None or annotationId in selected
                )
        if not storedPaths:
            return [
                {"path": path, **statsByKey[".".join(path)]}
                for path in propertyPaths
            ]

        match = {"datasetId": datasetId}
        if selector is not None:
            match["annotationId"] = selector

        group = {"_id": None}
        propertyPaths, requestedPaths = storedPaths, propertyPaths
        for index, path in enumerate(propertyPaths):
            ref = "$values." + ".".join(path)
            # $avg/$min/$max/$stdDevSamp skip nulls, so mapping every
            # non-number to null excludes strings and nested objects from
            # the statistics while $sum counts exactly the values used. NaN
            # is a number to $isNumber and would poison the mean, so it is
            # treated as missing too (BSON compares NaN equal to NaN, which
            # is what makes the $ne test work); Infinity stays a value.
            usable = {"$and": [
                {"$isNumber": ref}, {"$ne": [ref, float("nan")]},
            ]}
            numeric = {"$cond": [usable, ref, None]}
            group[f"count{index}"] = {"$sum": {"$cond": [usable, 1, 0]}}
            group[f"mean{index}"] = {"$avg": numeric}
            group[f"std{index}"] = {"$stdDevSamp": numeric}
            group[f"min{index}"] = {"$min": numeric}
            group[f"max{index}"] = {"$max": numeric}
        result = list(self._aggregate(
            self._pvModel.collection,
            [{"$match": match}, {"$group": group}],
        ))
        stats = result[0] if result else None
        for index, path in enumerate(propertyPaths):
            statsByKey[".".join(path)] = empty if stats is None else {
                "count": stats[f"count{index}"],
                "mean": stats[f"mean{index}"],
                "std": stats[f"std{index}"],
                "min": stats[f"min{index}"],
                "max": stats[f"max{index}"],
            }
        return [
            {"path": path, **statsByKey[".".join(path)]}
            for path in requestedPaths
        ]

    def listPosition(self, datasetId, filters, sort, annotationId):
        """Zero-based position of an annotation in a filtered/sorted list.

        This intentionally uses the annotation-driven form for every query.
        It has the same filter and ordering semantics as listPage, including
        property filters/sorts and the stable _id tie-break, while avoiding
        transfer of the full matching id set to the browser.
        """
        def basePipeline():
            return self._annotationDrivenStages(datasetId, filters, sort)

        # The default list order is _id ascending, and explicit _id sorting
        # is also common. Resolve that position with an indexed range count
        # on _id directly (no sort-value fetch needed).
        isIdSort = not sort or (
            sort.get("type") == "field" and sort.get("key") == "_id"
        )
        if isIdSort:
            targetPipeline = basePipeline()
            targetPipeline += [
                {"$match": {"_id": annotationId}},
                {"$limit": 1},
                {"$project": {"_id": 1}},
            ]
            if next(iter(self._aggregate(
                    self.collection, targetPipeline)), None) is None:
                return None

            comparison = "$gt" if (
                sort and sort.get("order") == "desc"
            ) else "$lt"
            countPipeline = basePipeline()
            countPipeline += [
                {"$match": {"_id": {comparison: annotationId}}},
                {"$count": "position"},
            ]
            result = next(iter(self._aggregate(
                self.collection, countPipeline
            )), None)
            return result["position"] if result else 0

        # Non-_id sorts: fetch the anchor's sort value inside the filtered
        # set, then COUNT the rows that sort strictly before it -- the same
        # match/lookup stages, but no full-set $sort or window walk. "Before"
        # replicates the page order (_hasSortValue desc, value asc/desc, _id
        # asc) as an expression. $ifNull maps a missing field to null exactly
        # like $sort does, so missing and null order identically here and in
        # listPage. `sort` is never None here: the isIdSort branch above
        # returns for a missing sort.
        descending = sort.get("order") == "desc"
        if sort.get("type") == "property":
            valueRef = {"$ifNull": ["$_sortValue", None]}
            hasValueRef = "$_hasSortValue"
        else:
            key = sort.get("key")
            if key not in self._SORTABLE_FIELDS:
                raise ValueError("Invalid sort field: %s" % key)
            valueRef = {"$ifNull": ["$" + key, None]}
            hasValueRef = None

        anchorPipeline = basePipeline()
        anchorPipeline += [
            {"$match": {"_id": annotationId}},
            {"$limit": 1},
            {"$project": {
                "_id": 0,
                "value": valueRef,
                "hasValue": hasValueRef or {"$literal": 1},
            }},
        ]
        anchor = next(iter(self._aggregate(
            self.collection, anchorPipeline)), None)
        if anchor is None:
            return None

        idBefore = {"$lt": ["$_id", annotationId]}
        if hasValueRef is not None and not anchor["hasValue"]:
            # The anchor lacks a value for the property sort key, so every
            # row WITH a value precedes it (_hasSortValue sorts descending
            # first regardless of direction); among no-value rows the order
            # is _id ascending.
            before = {"$or": [
                {"$eq": [hasValueRef, 1]},
                {"$and": [{"$eq": [hasValueRef, 0]}, idBefore]},
            ]}
        else:
            valueCmp = "$gt" if descending else "$lt"
            strictlyBefore = {valueCmp: [valueRef, anchor["value"]]}
            tieBefore = {"$and": [
                {"$eq": [valueRef, anchor["value"]]}, idBefore,
            ]}
            before = {"$or": [strictlyBefore, tieBefore]}
            if hasValueRef is not None:
                # The anchor has a value: only value-bearing rows can
                # precede it (no-value rows always sort after them).
                before = {"$and": [
                    {"$eq": [hasValueRef, 1]}, before,
                ]}

        countPipeline = basePipeline()
        countPipeline += [
            {"$match": {"$expr": before}},
            {"$count": "position"},
        ]
        result = next(iter(self._aggregate(
            self.collection, countPipeline)), None)
        return result["position"] if result else 0

    def _propertyComputeMatch(self, shape, tagSpec):
        """Match expression for the annotations a property CAN be computed on.

        Mirrors the client canComputeAnnotationProperty/tagFilterFunction:
        same shape, and inclusive -> the annotation carries all the property's
        tags ($all); exclusive -> the annotation's tags are exactly that set.
        Empty tags: inclusive matches every annotation of the shape; exclusive
        matches only untagged annotations.
        """
        match = {}
        if shape:
            match["shape"] = shape
        tagSpec = tagSpec or {}
        tags = tagSpec.get("tags") or []
        exclusive = bool(tagSpec.get("exclusive"))
        if tags:
            match["tags"] = (
                {"$all": tags, "$size": len(tags)} if exclusive
                else {"$all": tags}
            )
        elif exclusive:
            match["tags"] = {"$size": 0}
        return match

    def uncomputedCounts(self, datasetId, propertyFilters):
        """Per property, the count of annotations awaiting its computation.

        For each property in `propertyFilters` ({id, shape, tags:{tags,
        exclusive}}), returns the number of annotations matching its compute
        criteria (shape + tag rule) that have no computed value for it, as
        {propertyId: count}. Counts only -- never transfers values -- so a
        700K-annotation dataset never ships its full value map for the
        properties panel.

        Computed as total_matching - has_value. `has_value` counts
        property-value docs carrying the property's key; values are only ever
        written for annotations that matched at compute time, so re-tagging an
        annotation AFTER its value was computed can under-report the count by
        that one annotation. That edge case is acceptable for an informational
        badge and avoids a full per-annotation $lookup join (multi-second at
        700K).
        """
        if not propertyFilters:
            return {}

        # One $facet over the annotations: a branch per property counting the
        # documents that match its shape + tag rule. Project to {shape, tags}
        # first so the facet buffers tiny docs rather than full geometry.
        totalFacet = {
            "p%d" % i: [
                {"$match": self._propertyComputeMatch(
                    propertyFilter.get("shape"), propertyFilter.get("tags"))},
                {"$count": "n"},
            ]
            for i, propertyFilter in enumerate(propertyFilters)
        }
        totals = next(iter(self._aggregate(
            self.collection,
            [
                {"$match": {"datasetId": datasetId}},
                {"$project": {"shape": 1, "tags": 1}},
                {"$facet": totalFacet},
            ],
        )), {})

        # One streaming pass over the value docs: count, per top-level property
        # key, how many docs carry it. `values`' top-level keys are property
        # ids -- exactly the existence the client checks (propertyValues a/p).
        hasValueByProperty = {
            doc["_id"]: doc["n"]
            for doc in self._aggregate(
                self._pvModel.collection,
                [
                    {"$match": {"datasetId": datasetId}},
                    {"$project": {"k": {"$objectToArray": {
                        "$ifNull": ["$values", {}]}}}},
                    {"$unwind": "$k"},
                    {"$group": {"_id": "$k.k", "n": {"$sum": 1}}},
                ],
            )
        }

        counts = {}
        for i, propertyFilter in enumerate(propertyFilters):
            branch = totals.get("p%d" % i) or []
            total = branch[0]["n"] if branch else 0
            hasValue = hasValueByProperty.get(propertyFilter["id"], 0)
            counts[propertyFilter["id"]] = max(0, total - hasValue)
        return counts

    def _needsPropertyBeforePage(self, filters, sort):
        """Whether property values must be joined BEFORE pagination.

        Only a property sort (order depends on the value) or a property
        filter (which rows survive depends on the value) require the join
        ahead of $skip/$limit. Requesting property columns for display does
        not -- those values can be joined after the page is selected.
        """
        if sort and sort.get("type") == "property":
            return True
        return bool(filters.get("propertyFilters"))

    def _annotationDrivenStages(self, datasetId, filters, sort=None):
        """Annotation-driven pipeline prefix shared by the list queries.

        Match stages over annotation-document fields, plus -- only when a
        property filter (or property sort) requires the values before
        pagination -- the property-value join, property filters, and the
        property sort fields.
        """
        pipeline = self._buildListMatchStages(datasetId, filters)
        if self._needsPropertyBeforePage(filters, sort):
            pipeline += self._lookupStages()
            pipeline += self._propertyFilterStages(filters)
            pipeline += self._propertySortAddFields(sort)
        return pipeline

    def listPage(self, datasetId, filters, sort, propertyPaths,
                 offset, limit):
        storedPaths, _ = valueProviders.splitPaths(propertyPaths or [])
        rows = self._listPageRows(
            datasetId, filters, sort, storedPaths, offset, limit
        )
        return self._fillVirtualValues(datasetId, rows, propertyPaths)

    def _listPageRows(self, datasetId, filters, sort, propertyPaths,
                      offset, limit):
        skip = max(0, offset)
        if not self._needsPropertyBeforePage(filters, sort):
            # Sort by an annotation field (the {datasetId,_id} index orders
            # the default/_id case, so the page is found without scanning the
            # whole matched set), paginate, THEN join property values for
            # display and compute the centroid -- paying that per-row cost on
            # the page rather than on every matched annotation.
            pipeline = self._buildListMatchStages(datasetId, filters)
            pipeline.append(self._sortStage(sort))
            pipeline.append({"$skip": skip})
            pipeline.append({"$limit": limit})
            if propertyPaths:
                pipeline += self._lookupStages()
            pipeline.append(self._centroidAddFields())
            pipeline += self._projectStage(propertyPaths)
            return self._aggregate(self.collection, pipeline)

        if self._canDrivePvPage(filters, sort):
            # Drive from the property-values collection: sort/filter and
            # paginate the lean value docs, then join the annotation back for
            # just the page -- avoiding the join over the whole matched set.
            return self._pvDrivenPage(
                datasetId, filters, sort, propertyPaths, skip, limit
            )

        # Fallback: an annotation-field filter is combined with a property
        # sort/filter (the PV docs don't carry those fields), or a field sort
        # accompanies a property filter. Join, filter, sort, then paginate on
        # the annotation collection.
        pipeline = self._annotationDrivenStages(datasetId, filters, sort)
        pipeline.append(self._sortStage(sort))
        pipeline.append({"$skip": skip})
        pipeline.append({"$limit": limit})
        pipeline.append(self._centroidAddFields())
        pipeline += self._projectStage(propertyPaths)
        return self._aggregate(self.collection, pipeline)

    def getAnnotationById(self, id, user=None):
        return self.load(id, user=user, level=AccessType.READ)

    def updateMultiple(self, annotationIdToUpdate, user):
        """Update multiple annotations.

        :param annotationIdToUpdate: dict mapping ObjectId -> update dict.
            Each update dict should already have 'id'/'_id' removed and
            datasetId converted to ObjectId if present.
        :param user: The current user (for permission checks).
        :returns: List of saved annotation documents.
        """
        if not annotationIdToUpdate:
            return []

        query = {
            "_id": {
                "$in": list(annotationIdToUpdate.keys())
            },
        }
        cursor = self.findWithPermissions(
            query, user=user, level=AccessType.WRITE
        )
        expectedIds = set(annotationIdToUpdate.keys())
        foundIds = set()
        updatedAnnotations = []
        movedSourceDatasetIds = set()
        for annotation in cursor:
            annotationId = annotation["_id"]
            updateDoc = annotationIdToUpdate[annotationId]
            newDatasetId = updateDoc.get("datasetId")
            if (
                newDatasetId is not None
                and newDatasetId != annotation.get("datasetId")
            ):
                # This is the only path that moves an annotation between
                # datasets; saveMany only bumps the destination raster.
                movedSourceDatasetIds.add(annotation.get("datasetId"))
            annotation.update(updateDoc)
            foundIds.add(annotationId)
            updatedAnnotations.append(annotation)
        if foundIds != expectedIds:
            raise AccessException(
                "Write access was denied for one or more annotations."
            )
        saved = self.saveMany(updatedAnnotations)
        for datasetId in movedSourceDatasetIds:
            bumpDatasetRasterVersion(datasetId)
        return saved

    def clearColors(self, datasetId):
        """Reset every annotation color in the dataset to null (layer color).
        Returns the number of annotations in the dataset."""
        try:
            result = self.update(
                {"datasetId": datasetId}, {"$set": {"color": None}}
            )
        finally:
            # The overview raster renders each annotation's own color, and
            # its geometry cache and ETag are keyed by the dataset's raster
            # version. This path writes colors with a bulk update rather
            # than through save()/saveMany(), so nothing else bumps that
            # version and a revisited frame would keep serving pre-clear
            # colors (304 on an unchanged ETag) until the 120s cache-TTL
            # rotation. In a finally because a failed update can still have
            # cleared part of the dataset; a bump without a write only costs
            # one cache rebuild, the reverse serves wrong colors.
            bumpDatasetRasterVersion(datasetId)
        return result.matched_count

    @staticmethod
    def assignmentFromIdsByColor(idsByColor):
        """The {color: [ObjectId]} grouping as JSON-ready
        [{color, ids: [str]}].

        Lets a caller apply the same colors it just wrote without re-reading
        the dataset: the client patches the annotations it already holds
        instead of refetching every stub (measured 12.8s of refetch replaced
        by ~0.9s of serialize + patch on a 708K dataset)."""
        return [
            {"color": color, "ids": [str(i) for i in annotationIds]}
            for color, annotationIds in idsByColor.items()
        ]

    def colorByProperty(self, datasetId, propertyPath, mode="auto",
                        colormap=DEFAULT_COLORMAP,
                        rangeMin=None, rangeMax=None,
                        percentileLow=None, percentileHigh=None,
                        returnAssignment=False):
        """Assign each annotation's color from its value at propertyPath.

        Continuous mode maps numeric values through a colormap over
        [rangeMin, rangeMax]; an omitted bound resolves from the percentile
        parameters, which default to the 1st..99th (NOT the data extent —
        real distributions are long-tailed, and a full-extent ramp collapses
        into one bucket; see _colorContinuous). Categorical
        mode assigns palette colors per distinct value. Annotations without
        a usable value get color null (layer color). Returns
        {colored, uncolored, legend}, plus `assignment` (see
        assignmentFromIdsByColor) when returnAssignment is set.

        Deliberately not history-recorded: recording would snapshot every
        annotation document twice into a single history entry, which
        overruns the BSON document limit on large datasets. Re-coloring is
        the undo.
        """
        # Keyed by annotation, not a list of pairs: an annotation with two
        # property-value documents would otherwise appear in two color groups,
        # which (a) makes the winning color depend on unordered write order and
        # (b) inflates the covered-id count that _writeColors uses to decide
        # the clearing pass can be skipped, hiding an uncovered annotation's
        # stale color. Last value wins, deterministically by cursor order.
        valueByAnnotation = {}
        provider = valueProviders.providerFor(propertyPath)
        if provider is not None:
            # Providers key by id STRING; the membership guard and the color
            # writes below work in ObjectIds like the stored-value path.
            pairs = (
                (ObjectId(annotationId), value)
                for annotationId, value in provider.values(
                    datasetId, propertyPath
                ).items()
            )
        else:
            pairs = self._pvModel.valuesForPath(datasetId, propertyPath)
        for annotationId, value in pairs:
            valueByAnnotation[annotationId] = value

        # Membership guard: drop values whose annotation is not (or is no
        # longer) in this dataset. In normal app use this filters nothing —
        # the UI never moves an annotation between datasets, and deleting
        # annotations deletes their value documents (annotationsRemovedEvent).
        # But the guarded states are reachable through the API, so a value's
        # denormalized datasetId cannot be trusted:
        #   - the bulk update endpoint explicitly supports changing an
        #     annotation's datasetId (the single-update endpoint strips it;
        #     updateMultiple access-checks destinations and bumps source
        #     rasters), and moving an annotation does NOT move its value
        #     documents;
        #   - the value-creation endpoints never check that annotationId
        #     belongs to the claimed datasetId, so any script can insert a
        #     mismatched pair — including the app's own compute jobs, which
        #     can post values for annotations deleted mid-job (the removal
        #     cleanup fired before those values existed).
        # The update operations below are scoped by the ANNOTATION's
        # datasetId, so a stale pair can never recolor a foreign annotation
        # — but an unfiltered map would still drive the range, the category
        # counts, and the returned assignment, distorting the legend and
        # listing ids that were never written. One dataset-scoped, indexed
        # id scan, NOT a chunked $in loop: chunking at COLOR_WRITE_CHUNK
        # meant ~15 sequential round trips on the measured 708K dataset
        # before any coloring started, and the whole id set is already in
        # memory (valueByAnnotation's keys) at this point anyway.
        presentIds = {
            document["_id"]
            for document in self.find(
                {"datasetId": datasetId}, fields=["_id"]
            )
        }
        valueByAnnotation = {
            annotationId: value
            for annotationId, value in valueByAnnotation.items()
            if annotationId in presentIds
        }

        if not valueByAnnotation:
            raise ValueError(
                "No values found for this property in this dataset"
            )

        # bool is an int subclass but "true/false" is a category, not a
        # quantity; non-finite floats (NaN/inf) can't be range-mapped.
        numericPairs = [
            (annotationId, float(value))
            for annotationId, value in valueByAnnotation.items()
            if not isinstance(value, bool)
            and isinstance(value, (int, float))
            and math.isfinite(value)
        ]

        if mode == "auto":
            # Mostly-numeric values are a quantity with stray labels;
            # anything else is treated as categories.
            numericFraction = len(numericPairs) / len(valueByAnnotation)
            mode = "continuous" if numericFraction >= 0.9 else "categorical"

        # The private colorers return (result, idsByColor) so the assignment
        # can be surfaced without threading a flag through both of them.
        if mode == "continuous":
            result, idsByColor = self._colorContinuous(
                datasetId, propertyPath, numericPairs, colormap,
                rangeMin, rangeMax, percentileLow, percentileHigh
            )
        else:
            result, idsByColor = self._colorCategorical(
                datasetId, propertyPath, valueByAnnotation.items()
            )
        if returnAssignment:
            result["assignment"] = self.assignmentFromIdsByColor(idsByColor)
        return result

    @staticmethod
    def _percentileOf(sortedValues, percentile):
        """Linear-interpolated percentile of an ascending-sorted list."""
        if percentile <= 0:
            return sortedValues[0]
        if percentile >= 100:
            return sortedValues[-1]
        position = (len(sortedValues) - 1) * percentile / 100.0
        lowIndex = int(position)
        highIndex = min(lowIndex + 1, len(sortedValues) - 1)
        fraction = position - lowIndex
        low = sortedValues[lowIndex]
        return low + (sortedValues[highIndex] - low) * fraction

    def _colorContinuous(self, datasetId, propertyPath, numericPairs,
                         colormap, rangeMin, rangeMax,
                         percentileLow=None, percentileHigh=None):
        """Returns (result, idsByColor) -- see colorByProperty."""
        if not numericPairs:
            raise ValueError(
                "No numeric values found for this property; "
                "try categorical mode"
            )
        # Sorted once: feeds both the extent and the percentile bounds.
        values = sorted(value for _, value in numericPairs)
        dataMin, dataMax = values[0], values[-1]
        # An explicit absolute bound means the caller is choosing the range, so
        # resolve its partner from the data extent rather than a percentile.
        # Mixing the two produced bafflement: rangeMax=1.5 on right-skewed data
        # was rejected against an unrequested p1 of 1.99.
        explicitBound = rangeMin is not None or rangeMax is not None
        if percentileLow is None:
            percentileLow = 0.0 if explicitBound else (
                self.DEFAULT_PERCENTILE_LOW
            )
        if percentileHigh is None:
            percentileHigh = 100.0 if explicitBound else (
                self.DEFAULT_PERCENTILE_HIGH
            )
        low = (
            self._percentileOf(values, percentileLow)
            if rangeMin is None
            else float(rangeMin)
        )
        high = (
            self._percentileOf(values, percentileHigh)
            if rangeMax is None
            else float(rangeMax)
        )
        # Test the RESOLVED range, not "was a bound explicit": a single
        # percentile can invert it just as a single absolute bound can
        # (percentileLow=99.5 against the default high of 99), which otherwise
        # painted every annotation the middle color under a legend whose min
        # exceeded its max. Only a strict inversion is an error -- bounds that
        # coincide are the span <= 0 branch's job (every value identical, or an
        # explicit min equal to the data's single value).
        if low > high:
            raise ValueError(
                "The requested range [%g, %g] is empty for this "
                "property's values" % (low, high)
            )
        span = high - low
        # Individually finite bounds can still overflow their DIFFERENCE
        # (rangeMin=-1e308, rangeMax=1e308 → span == inf): every t below
        # would compute against infinity — near-zero values silently landing
        # on the first color, a value at the bound producing NaN. Raised
        # before any write, like every ValueError in this path (the API
        # relays it as a 400 and the client skips its refetch on 400s).
        if not math.isfinite(span):
            raise ValueError(
                "The requested range [%g, %g] is too wide to color by"
                % (low, high)
            )

        # Sample the colormap once per quantized level, not once per
        # annotation: table[level] == sampleColormap(colormap,
        # level / maxLevel), so the colors are identical and the hot loop is
        # a list index instead of a parse-and-interpolate.
        maxLevel = self.CONTINUOUS_COLOR_LEVELS - 1
        table = colormapTable(colormap, self.CONTINUOUS_COLOR_LEVELS)
        idsByColor = defaultdict(list)
        for annotationId, value in numericPairs:
            if span > 0:
                t = (value - low) / span
            elif value < low:
                # A zero-width range still has an inside and an outside: p1 ==
                # p99 happens on sparse data (199 zeros and one 1000), and
                # painting the outliers the middle colour contradicted the
                # legend, which reports clippedHigh in exactly that case.
                t = 0.0
            elif value > high:
                t = 1.0
            else:
                # Every value identical, or exactly on the collapsed bound.
                t = 0.5
            level = int(round(min(max(t, 0.0), 1.0) * maxLevel))
            idsByColor[table[level]].append(annotationId)

        counts = self._writeColors(datasetId, idsByColor)
        counts["legend"] = {
            "type": "continuous",
            "propertyPath": propertyPath,
            "colormap": colormap,
            "stops": CONTINUOUS_COLORMAPS[colormap],
            "min": low,
            "max": high,
            # True extent + whether the ramp clipped it, so the legend can
            # label its ends "≤ low" / "≥ high" instead of implying the range
            # is all the data there is.
            "dataMin": dataMin,
            "dataMax": dataMax,
            "clippedLow": low > dataMin,
            "clippedHigh": high < dataMax,
        }
        return counts, idsByColor

    def _colorCategorical(self, datasetId, propertyPath, pairs):
        """Returns (result, idsByColor) -- see colorByProperty."""
        idsByLabel = defaultdict(list)
        for annotationId, value in pairs:
            if isinstance(value, str):
                label = value
            elif isinstance(value, float) and value.is_integer():
                # Workers disagree on numeric types (one writes 1, another
                # 1.0); don't let the representation split a category.
                label = str(int(value))
            else:
                label = str(value)
            idsByLabel[label].append(annotationId)
            # Bail the moment the cap is exceeded rather than grouping every
            # distinct value first: forcing categorical on a continuous
            # property would otherwise build one entry per value (observed
            # live: 555,479 groups before a 256 cap rejected the request).
            if len(idsByLabel) > self.MAX_CATEGORIES:
                raise ValueError(
                    "Too many distinct values (more than %d) for categorical "
                    "coloring; use continuous mode or another property"
                    % self.MAX_CATEGORIES
                )

        # Largest categories get the leading (strongest) palette colors;
        # ties break alphabetically so re-running is stable.
        ordered = sorted(
            idsByLabel.items(), key=lambda item: (-len(item[1]), item[0])
        )
        categories = []
        idsByColor = defaultdict(list)
        for index, (label, annotationIds) in enumerate(ordered):
            color = categoricalColor(index)
            categories.append(
                {"value": label, "color": color, "count": len(annotationIds)}
            )
            idsByColor[color].extend(annotationIds)

        counts = self._writeColors(datasetId, idsByColor)
        counts["legend"] = {
            "type": "categorical",
            "propertyPath": propertyPath,
            "categories": categories,
        }
        return counts, idsByColor

    def _buildColorOperations(self, datasetId, idsByColor):
        """One bulk $set per distinct color, chunked so a single $in stays
        reasonable."""
        operations = []
        for color, annotationIds in idsByColor.items():
            for start in range(0, len(annotationIds), self.COLOR_WRITE_CHUNK):
                chunk = annotationIds[start:start + self.COLOR_WRITE_CHUNK]
                # datasetId keeps the write scoped to the access-checked
                # dataset even if a foreign annotation id slipped into the
                # property values, and lets Mongo use the compound index.
                operations.append(UpdateMany(
                    {"datasetId": datasetId, "_id": {"$in": chunk}},
                    {"$set": {"color": color}},
                ))
        return operations

    def _applyColorOperations(self, operations):
        """Run the color assignment as one batched write, returning how many
        annotations matched.

        bulk_write, not a loop of Model.update(): one round trip instead of up
        to 256. Girder exposes no batched-write API, which makes this the same
        kind of sanctioned `collection` use as aggregate() -- and unlike
        find()/load(), update paths add no security behavior to bypass.
        Unordered so Mongo may parallelize; every operation targets a disjoint
        id set, so order cannot matter between them.

        Bypassing save()/saveMany() also bypasses their raster-version bump,
        so _writeColors bumps it explicitly (see clearColors)."""
        if not operations:
            return 0
        return self.collection.bulk_write(
            operations, ordered=False
        ).matched_count

    def _writeColors(self, datasetId, idsByColor):
        """Apply the color assignment, clearing first only when it doesn't
        cover every annotation. Returns {colored, uncolored}.

        The clearing pass exists so annotations WITHOUT a value fall back to
        their layer color instead of keeping a stale one. When the assignment
        covers the whole dataset it is pure waste: the $sets overwrite every
        document anyway, and on a 708K-annotation dataset the clear cost 4.8s
        directly plus ~4.5s indirectly (708K dirty pages left for the
        following writes to contend with) -- 80% of the request.

        When a clear IS needed it must complete BEFORE the assignment, as its
        own round trip: batched writes are unordered, so a clear sharing their
        batch could land after a $set and wipe it."""
        total = self.collection.count_documents({"datasetId": datasetId})
        operations = self._buildColorOperations(datasetId, idsByColor)
        # No empty-operations branch: both colorers raise before producing an
        # empty assignment, and if one ever did, the code below is already
        # correct for it (clear, then apply nothing).
        # Ids are unique across groups (colorByProperty keys by annotation), so
        # this total is a distinct-annotation count and the matched_count
        # cross-check below is sound.
        coveredIds = sum(len(ids) for ids in idsByColor.values())
        skipClear = coveredIds >= total
        try:
            if not skipClear:
                self.clearColors(datasetId)
            colored = self._applyColorOperations(operations)

            if skipClear and colored < total:
                # The id count implied full coverage but the writes
                # disagree. colorByProperty filters its map to annotations
                # actually in the dataset, so the known cause (a stale
                # property value whose annotation moved datasets) is
                # prevented upstream — this stays as the backstop for
                # anything else that desynchronizes the count, because some
                # annotations may still hold a stale color. Fall back to
                # the clear-then-reapply order.
                self.clearColors(datasetId)
                colored = self._applyColorOperations(operations)
        finally:
            # The assignment writes are the half clearColors' bump does not
            # cover (skipClear skips it entirely), and they are what changes
            # the colors the overview raster draws. In a finally because an
            # unordered bulk_write can raise after applying some operations
            # — exactly when the cached raster is most wrong (see
            # clearColors).
            bumpDatasetRasterVersion(datasetId)
        return {"colored": colored, "uncolored": max(total - colored, 0)}

    def compute(self, datasetId, tool, user=None):
        dataset = Folder().load(
            datasetId, user=user, level=AccessType.WRITE
        )
        if not dataset:
            raise ValidationException(
                "Invalid dataset id in annotation"
            )
        image = tool.get("image", None)
        if not image:
            raise ValidationException(
                "Invalid segmentation tool: no image"
            )
        return runJobRequest(image, datasetId, tool, "compute")

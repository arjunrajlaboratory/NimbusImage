import re

import fastjsonschema

from bson.objectid import ObjectId

from girder import events
from girder.constants import AccessType, SortDir
from girder.exceptions import AccessException, ValidationException
from girder.models.folder import Folder

from girder.utility.acl_mixin import AccessControlMixin

from ..helpers.fastjsonschema import customJsonSchemaCompile
from ..helpers.proxiedModel import ProxiedModel
from ..helpers.tasks import runJobRequest
from .propertyValues import AnnotationPropertyValues

# Bound any single aggregation's DB runtime so one expensive query (e.g. over a
# 700K-annotation public dataset) can't run unbounded and pin a Mongo
# connection. 5 minutes: comfortably above the slowest legitimate query, but a
# hard ceiling against a runaway one.
AGGREGATION_MAX_TIME_MS = 300000
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
        if idConstraints:
            match["$and"] = [
                {"_id": {"$in": list(ids)}}
                for ids in idConstraints
            ]

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
        for annotation in cursor:
            annotationId = annotation["_id"]
            updateDoc = annotationIdToUpdate[annotationId]
            annotation.update(updateDoc)
            foundIds.add(annotationId)
            updatedAnnotations.append(annotation)
        if foundIds != expectedIds:
            raise AccessException(
                "Write access was denied for one or more annotations."
            )
        return self.saveMany(updatedAnnotations)

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

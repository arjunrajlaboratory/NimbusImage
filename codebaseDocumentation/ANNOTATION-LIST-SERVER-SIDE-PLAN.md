# Server-Side Annotation List Implementation Plan

> **✅ IMPLEMENTED 2026-06-18** on `feature/stub-annotations`. All tasks (1–7, plus the real-data checkpoint and a follow-up `idConstraints` task) are done, two-stage-reviewed, and real-data-validated (HCR 26K 16/16, Xenium 708K functional, idConstraints 7/7). Backend: 18 `test_server_list` tests; frontend: ~70 list-related tests; tsc clean. See `ANNOTATION-LIST-SERVER-SIDE-DESIGN.md` (As-built notes) for deviations from this plan — notably rows carry `_id` (not `id`), `idConstraints` was added for selection/annotation-id filters, the refetch is debounced ~300 ms, and the perf pass is deferred. The task bodies below are kept as the historical implementation record.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the AnnotationList's pagination, sorting, and filtering server-side above a size threshold, loading property values only for the visible page — so large datasets no longer hold all rows or all property values in the browser.

**Architecture:** Dual-mode list mirroring the existing stub system. Below the threshold the current client-side list is unchanged; above it, a new annotation-driven MongoDB aggregation (`POST /upenn_annotation/list`) returns a page of stub-shaped rows + the requested property-column values + a total count, and `POST /upenn_annotation/list/ids` returns all matching IDs for Select All / Delete Unselected. The frontend uses Vuetify server-items mode driven by a focused new store module.

**Tech Stack:** Girder (Python) + MongoDB aggregation + orjson streaming; Vue 3 `<script setup>` + Vuetify 4 `v-data-table` server-items; Vuex (`vuex-module-decorators`); pytest/tox (backend), vitest (frontend).

**Spec:** `codebaseDocumentation/ANNOTATION-LIST-SERVER-SIDE-DESIGN.md`.

**Key conventions to honor (from CLAUDE.md):**
- API layer parses/validates input + handles HTTP/streaming; **model layer** builds queries and runs the aggregation (raise `ValueError`/`ValidationException` in the model, `RestException` only in the API).
- Use `Model().collection.aggregate(...)` (the documented exception for aggregations).
- Convert IDs to `ObjectId` once at the top of the API method.
- Tag semantics MUST match the client `tagCloudFilterFunction` (`src/utils/annotation.ts:232`): **inclusive → `$in`** (has any), **exclusive → `$all` + `$size`** (exactly that set). This is intentionally different from the existing `find` endpoint's `$all` (superset) semantics.

**Backend dir (abbrev `B`):** `devops/girder/plugins/AnnotationPlugin/upenncontrast_annotation`
**Backend test command:** `cd devops/girder/plugins/AnnotationPlugin && tox` (runs pytest + flake8). Targeted: `tox -- upenncontrast_annotation/test/test_server_list.py -v` if posargs supported; otherwise run full `tox`.
**Frontend test command:** `pnpm exec vitest run <file>`; type check `pnpm tsc`; lint `pnpm exec eslint <files>`.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `B/server/models/annotation.py` | `listIds`, `listCount`, `listPage` + private pipeline builders | Modify |
| `B/server/api/annotation.py` | `POST /list`, `POST /list/ids` routes + handlers (parse/validate/stream) | Modify |
| `B/test/test_server_list.py` | Integration tests for both endpoints | Create |
| `src/store/model.ts` | `IAnnotationListRow`, `IAnnotationListQuery`, `IAnnotationListSort` types | Modify |
| `src/store/AnnotationsAPI.ts` | `fetchAnnotationListPage`, `fetchAnnotationListIds`, `toListRow` | Modify |
| `src/store/annotationListServer.ts` | Server-mode list state + fetch (new Vuex module) | Create |
| `src/store/__tests__/annotationListServer.test.ts` | Store module tests | Create |
| `src/store/AnnotationsAPI.test.ts` (or existing) | API client tests | Create/Modify |
| `src/components/AnnotationBrowser/AnnotationList.vue` | Dual-mode: server-items binding, loading, ROI notice, selection wiring | Modify |
| `src/components/AnnotationBrowser/AnnotationList.test.ts` | Server-mode + selection tests | Modify |

Phasing: backend `/list/ids` → `/list` (field sort) → property lookup; then frontend API → store module → component wiring → selection.

---

## Task 1: Backend — `POST /upenn_annotation/list/ids` (filters → matching IDs)

Establishes the shared annotation-field match (dataset, shape, tags incl/excl, location, idSubstring).

**Files:**
- Modify: `B/server/models/annotation.py`
- Modify: `B/server/api/annotation.py`
- Test: `B/test/test_server_list.py` (create)

- [ ] **Step 1: Write the failing test**

Create `B/test/test_server_list.py`:

```python
import json
import pytest

from pytest_girder.assertions import assertStatus, assertStatusOk

from upenncontrast_annotation.server.models.annotation import Annotation
from upenncontrast_annotation.server.models.propertyValues import (
    AnnotationPropertyValues,
)

from . import girder_utilities as utilities
from . import upenn_testing_utilities as upenn_utilities


def makeAnnotation(datasetId, coords=None, tags=None, shape="polygon",
                   location=None):
    ann = upenn_utilities.getSampleAnnotation(datasetId)
    ann["coordinates"] = coords or [
        {"x": 0, "y": 0}, {"x": 10, "y": 0},
        {"x": 10, "y": 10}, {"x": 0, "y": 10},
    ]
    ann["shape"] = shape
    if tags is not None:
        ann["tags"] = tags
    if location is not None:
        ann["location"] = location
    return Annotation().create(ann)


def parseStreaming(resp):
    return json.loads(b"".join(resp.body))


def postList(server, user, path, body):
    return server.request(
        path=path, method="POST", user=user,
        body=json.dumps(body), type="application/json", isJson=False,
    )


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestServerListIds:
    def testListIdsFilterByTagsInclusive(self, admin, server):
        folder = utilities.createFolder(
            admin, "ds", upenn_utilities.datasetMetadata
        )
        a = makeAnnotation(folder["_id"], tags=["A"])
        b = makeAnnotation(folder["_id"], tags=["B"])
        makeAnnotation(folder["_id"], tags=["C"])

        resp = postList(server, admin, "/upenn_annotation/list/ids", {
            "datasetId": str(folder["_id"]),
            "filters": {"tags": {"values": ["A", "B"], "exclusive": False}},
        })
        assertStatusOk(resp)
        result = parseStreaming(resp)
        assert set(result["ids"]) == {str(a["_id"]), str(b["_id"])}
        assert result["total"] == 2

    def testListIdsFilterByTagsExclusive(self, admin, server):
        folder = utilities.createFolder(
            admin, "ds", upenn_utilities.datasetMetadata
        )
        exact = makeAnnotation(folder["_id"], tags=["A", "B"])
        makeAnnotation(folder["_id"], tags=["A", "B", "C"])  # superset, excluded
        makeAnnotation(folder["_id"], tags=["A"])             # subset, excluded

        resp = postList(server, admin, "/upenn_annotation/list/ids", {
            "datasetId": str(folder["_id"]),
            "filters": {"tags": {"values": ["A", "B"], "exclusive": True}},
        })
        assertStatusOk(resp)
        result = parseStreaming(resp)
        assert result["ids"] == [str(exact["_id"])]

    def testListIdsRequiresReadAccess(self, admin, user, server):
        folder = utilities.createFolder(
            admin, "ds", upenn_utilities.datasetMetadata
        )
        makeAnnotation(folder["_id"])
        resp = postList(server, user, "/upenn_annotation/list/ids", {
            "datasetId": str(folder["_id"]),
            "filters": {},
        })
        assertStatus(resp, 403)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd devops/girder/plugins/AnnotationPlugin && tox -- upenncontrast_annotation/test/test_server_list.py -v` (or full `tox`)
Expected: FAIL — route `/upenn_annotation/list/ids` returns 400/404 (not registered).

- [ ] **Step 3: Add model match-builder + `listIds`**

In `B/server/models/annotation.py`, add these methods to the `Annotation` class (after `deleteMultiple`):

```python
    def _buildListMatchStages(self, datasetId, filters):
        """Pipeline stages matching annotation-document fields.

        Tag semantics mirror the client tagCloudFilterFunction:
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
            match["location.XY"] = location["XY"]
            match["location.Z"] = location["Z"]
            match["location.Time"] = location["Time"]

        stages = [{"$match": match}]

        idSubstring = filters.get("idSubstring")
        if idSubstring:
            stages.append({"$match": {"$expr": {"$regexMatch": {
                "input": {"$toString": "$_id"},
                "regex": idSubstring,
            }}}})
        return stages

    def listIds(self, datasetId, filters):
        """All annotation _ids (as strings) matching the filters."""
        pipeline = self._buildListMatchStages(datasetId, filters)
        pipeline.append({"$project": {"_id": 1}})
        cursor = self.collection.aggregate(
            pipeline, hint={"datasetId": 1, "_id": 1}, allowDiskUse=True
        )
        return [str(doc["_id"]) for doc in cursor]
```

- [ ] **Step 4: Register route + add API handler**

In `B/server/api/annotation.py` `__init__`, after the `hydrate` route (line ~89) add:

```python
        self.route("POST", ("list",), self.listAnnotations)
        self.route("POST", ("list", "ids"), self.listAnnotationIds)
```

Add the handler (near `hydrate`, end of class). Reuse imports already present (`ObjectId`, `Folder`, `AccessType`, `TokenScope`, `orjson`, `orJsonDefaults`, `setResponseHeader`, `memoizeBodyJson`):

```python
    @access.public(scope=TokenScope.DATA_READ)
    @describeRoute(
        Description("Annotation IDs matching list filters")
        .param("body", "JSON: {datasetId, filters}", paramType="body")
        .errorResponse()
        .errorResponse("Read access denied.", 403)
    )
    @memoizeBodyJson
    def listAnnotationIds(self, params, *args, **kwargs):
        body = kwargs["memoizedBodyJson"]
        datasetId = ObjectId(body["datasetId"])
        Folder().load(
            datasetId, user=self.getCurrentUser(),
            level=AccessType.READ, exc=True,
        )
        filters = body.get("filters") or {}
        ids = self._annotationModel.listIds(datasetId, filters)

        def generateResult():
            chunk = [b'{"total":', str(len(ids)).encode(), b',"ids":[']
            first = True
            for sid in ids:
                if not first:
                    chunk.append(b",")
                chunk.append(orjson.dumps(sid))
                first = False
                if len(chunk) > 1000:
                    yield b"".join(chunk)
                    chunk = []
            chunk.append(b"]}")
            yield b"".join(chunk)

        setResponseHeader("Content-Type", "application/json")
        return generateResult
```

(Define `listAnnotations` as a temporary stub returning `[]` so the route registration in `__init__` doesn't reference a missing method; it is fully implemented in Task 2:

```python
    @access.public(scope=TokenScope.DATA_READ)
    @describeRoute(Description("List annotations (page)"))
    @memoizeBodyJson
    def listAnnotations(self, params, *args, **kwargs):
        return []
```
)

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd devops/girder/plugins/AnnotationPlugin && tox -- upenncontrast_annotation/test/test_server_list.py -v`
Expected: 3 tests PASS. flake8 clean.

- [ ] **Step 6: Commit**

```bash
git add devops/girder/plugins/AnnotationPlugin/upenncontrast_annotation/server/models/annotation.py \
        devops/girder/plugins/AnnotationPlugin/upenncontrast_annotation/server/api/annotation.py \
        devops/girder/plugins/AnnotationPlugin/upenncontrast_annotation/test/test_server_list.py
git commit -m "feat(backend): annotation list/ids endpoint with client-matching tag semantics"
```

---

## Task 2: Backend — `POST /upenn_annotation/list` (page + field sort + count, no properties yet)

**Files:** Modify `B/server/models/annotation.py`, `B/server/api/annotation.py`; Test `B/test/test_server_list.py`.

- [ ] **Step 1: Write the failing tests**

Append to `test_server_list.py`:

```python
@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestServerListPage:
    def testListPaginatesAndCounts(self, admin, server):
        folder = utilities.createFolder(
            admin, "ds", upenn_utilities.datasetMetadata
        )
        for i in range(5):
            makeAnnotation(folder["_id"], location={"XY": i, "Z": 0, "Time": 0})

        resp = postList(server, admin, "/upenn_annotation/list", {
            "datasetId": str(folder["_id"]),
            "filters": {},
            "sort": {"type": "field", "key": "location.XY", "order": "asc"},
            "propertyPaths": [],
            "offset": 0, "limit": 2,
        })
        assertStatusOk(resp)
        result = parseStreaming(resp)
        assert result["total"] == 5
        assert len(result["rows"]) == 2
        assert result["rows"][0]["location"]["XY"] == 0
        assert result["rows"][1]["location"]["XY"] == 1
        # Stub-shaped: centroid present, coordinates absent
        assert "centroid" in result["rows"][0]
        assert "coordinates" not in result["rows"][0]

    def testListFieldSortDescending(self, admin, server):
        folder = utilities.createFolder(
            admin, "ds", upenn_utilities.datasetMetadata
        )
        for i in range(3):
            makeAnnotation(folder["_id"], location={"XY": i, "Z": 0, "Time": 0})
        resp = postList(server, admin, "/upenn_annotation/list", {
            "datasetId": str(folder["_id"]),
            "filters": {},
            "sort": {"type": "field", "key": "location.XY", "order": "desc"},
            "propertyPaths": [], "offset": 0, "limit": 10,
        })
        result = parseStreaming(resp)
        xys = [r["location"]["XY"] for r in result["rows"]]
        assert xys == [2, 1, 0]
```

- [ ] **Step 2: Run to verify failure**

Run: `tox -- upenncontrast_annotation/test/test_server_list.py::TestServerListPage -v`
Expected: FAIL — `listAnnotations` returns `[]` (stub).

- [ ] **Step 3: Add `listCount` + `listPage` + centroid/sort builders to the model**

In `B/server/models/annotation.py`, add (after `listIds`). Note the centroid `$addFields` mirrors the `stubs` endpoint:

```python
    # Annotation fields allowed as a sort key (field-type sort).
    _SORTABLE_FIELDS = {"location.XY", "location.Z", "location.Time",
                        "name", "channel", "_id"}

    def _centroidAddFields(self):
        return {"$addFields": {"centroid": {
            "x": {"$avg": "$coordinates.x"},
            "y": {"$avg": "$coordinates.y"},
        }}}

    def _sortStage(self, sort):
        """$sort stage for a field-type sort (property sort added in
        a later task). Always tie-break on _id for stable paging."""
        direction = -1 if (sort or {}).get("order") == "desc" else 1
        if sort and sort.get("type") == "field":
            key = sort.get("key")
            if key not in self._SORTABLE_FIELDS:
                raise ValueError("Invalid sort field: %s" % key)
            if key == "_id":
                return {"$sort": {"_id": direction}}
            return {"$sort": {key: direction, "_id": 1}}
        return {"$sort": {"_id": 1}}

    def listCount(self, datasetId, filters):
        pipeline = self._buildListMatchStages(datasetId, filters)
        pipeline.append({"$count": "n"})
        result = list(self.collection.aggregate(
            pipeline, hint={"datasetId": 1, "_id": 1}, allowDiskUse=True
        ))
        return result[0]["n"] if result else 0

    def listPage(self, datasetId, filters, sort, propertyPaths,
                 offset, limit):
        pipeline = self._buildListMatchStages(datasetId, filters)
        pipeline.append(self._centroidAddFields())
        pipeline.append(self._sortStage(sort))
        pipeline.append({"$skip": max(0, offset)})
        pipeline.append({"$limit": limit})
        pipeline.append({"$project": {"coordinates": 0}})
        return self.collection.aggregate(
            pipeline, hint={"datasetId": 1, "_id": 1}, allowDiskUse=True
        )
```

- [ ] **Step 4: Implement the `listAnnotations` API handler**

Replace the Task-1 stub `listAnnotations` in `B/server/api/annotation.py` with:

```python
    @access.public(scope=TokenScope.DATA_READ)
    @describeRoute(
        Description("List annotations (paged), stub-shaped + property values")
        .param("body", "JSON: {datasetId, filters, sort, propertyPaths, "
                       "offset, limit}", paramType="body")
        .errorResponse()
        .errorResponse("Read access denied.", 403)
    )
    @memoizeBodyJson
    def listAnnotations(self, params, *args, **kwargs):
        body = kwargs["memoizedBodyJson"]
        datasetId = ObjectId(body["datasetId"])
        Folder().load(
            datasetId, user=self.getCurrentUser(),
            level=AccessType.READ, exc=True,
        )
        filters = body.get("filters") or {}
        sort = body.get("sort")
        propertyPaths = body.get("propertyPaths") or []
        offset = int(body.get("offset", 0))
        limit = int(body.get("limit", 50))

        total = self._annotationModel.listCount(datasetId, filters)
        cursor = self._annotationModel.listPage(
            datasetId, filters, sort, propertyPaths, offset, limit
        )

        def generateResult():
            chunk = [b'{"total":', str(total).encode(), b',"rows":[']
            first = True
            for row in cursor:
                if not first:
                    chunk.append(b",")
                chunk.append(orjson.dumps(row, default=orJsonDefaults))
                first = False
                if len(chunk) > 1000:
                    yield b"".join(chunk)
                    chunk = []
            chunk.append(b"]}")
            yield b"".join(chunk)

        setResponseHeader("Content-Type", "application/json")
        return generateResult
```

Note: the model raises `ValueError` for an invalid sort field; convert it at the API boundary. Wrap the `listPage` call:

```python
        try:
            cursor = self._annotationModel.listPage(
                datasetId, filters, sort, propertyPaths, offset, limit
            )
        except ValueError as e:
            raise RestException(str(e), code=400)
```

(`RestException` is already imported in this file.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `tox -- upenncontrast_annotation/test/test_server_list.py -v`
Expected: all Task 1 + Task 2 tests PASS. flake8 clean.

- [ ] **Step 6: Commit**

```bash
git add devops/girder/plugins/AnnotationPlugin/upenncontrast_annotation/server/models/annotation.py \
        devops/girder/plugins/AnnotationPlugin/upenncontrast_annotation/server/api/annotation.py \
        devops/girder/plugins/AnnotationPlugin/upenncontrast_annotation/test/test_server_list.py
git commit -m "feat(backend): annotation list page endpoint (field sort + count)"
```

---

## Task 3: Backend — property lookup (sort-by-property, property filters, return values)

**Files:** Modify `B/server/models/annotation.py`; Test `B/test/test_server_list.py`.

- [ ] **Step 1: Write the failing tests**

Append to `test_server_list.py`:

```python
@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestServerListProperties:
    def _setup(self, admin):
        folder = utilities.createFolder(
            admin, "ds", upenn_utilities.datasetMetadata
        )
        pv = AnnotationPropertyValues()
        anns = []
        # values 30, 10, 20 for prop "p"/"Area"; a 4th with no value
        for val in (30, 10, 20):
            a = makeAnnotation(folder["_id"])
            pv.appendValues({"p": {"Area": val}}, a["_id"], folder["_id"])
            anns.append(a)
        noval = makeAnnotation(folder["_id"])
        return folder, anns, noval

    def testSortByPropertyAscMissingLast(self, admin, server):
        folder, anns, noval = self._setup(admin)
        resp = postList(server, admin, "/upenn_annotation/list", {
            "datasetId": str(folder["_id"]),
            "filters": {},
            "sort": {"type": "property", "key": ["p", "Area"], "order": "asc"},
            "propertyPaths": [["p", "Area"]],
            "offset": 0, "limit": 10,
        })
        result = parseStreaming(resp)
        vals = [r["values"]["p"]["Area"] for r in result["rows"][:3]]
        assert vals == [10, 20, 30]
        # Annotation with no value sorts to the end regardless of direction.
        # Its projected `values` has no Area (the $ifNull/$$REMOVE drops the
        # leaf; the `p` wrapper may remain as {}).
        last = result["rows"][-1]
        assert last["id"] == str(noval["_id"])
        assert "Area" not in last.get("values", {}).get("p", {})

    def testSortByPropertyDescMissingStillLast(self, admin, server):
        folder, anns, noval = self._setup(admin)
        resp = postList(server, admin, "/upenn_annotation/list", {
            "datasetId": str(folder["_id"]),
            "filters": {},
            "sort": {"type": "property", "key": ["p", "Area"], "order": "desc"},
            "propertyPaths": [["p", "Area"]],
            "offset": 0, "limit": 10,
        })
        result = parseStreaming(resp)
        vals = [r["values"]["p"]["Area"] for r in result["rows"][:3]]
        assert vals == [30, 20, 10]
        assert result["rows"][-1]["id"] == str(noval["_id"])

    def testPropertyRangeFilterAffectsCountAndRows(self, admin, server):
        folder, anns, noval = self._setup(admin)
        body = {
            "datasetId": str(folder["_id"]),
            "filters": {"propertyFilters": [
                {"path": ["p", "Area"], "mode": "range", "min": 15, "max": 100}
            ]},
            "sort": {"type": "property", "key": ["p", "Area"], "order": "asc"},
            "propertyPaths": [["p", "Area"]], "offset": 0, "limit": 10,
        }
        resp = postList(server, admin, "/upenn_annotation/list", body)
        result = parseStreaming(resp)
        assert result["total"] == 2  # 20 and 30
        assert [r["values"]["p"]["Area"] for r in result["rows"]] == [20, 30]

        # /list/ids must agree with the same filters
        resp2 = postList(server, admin, "/upenn_annotation/list/ids", {
            "datasetId": str(folder["_id"]), "filters": body["filters"],
        })
        assert parseStreaming(resp2)["total"] == 2
```

- [ ] **Step 2: Run to verify failure**

Run: `tox -- upenncontrast_annotation/test/test_server_list.py::TestServerListProperties -v`
Expected: FAIL — no property lookup; `values` absent, property sort/filter not applied.

- [ ] **Step 3: Add property lookup to the pipeline builders**

In `B/server/models/annotation.py`, add the property helpers and update `_buildListMatchStages`-consumers. Add these methods:

```python
    PROPERTY_VALUES_COLLECTION = "annotation_property_values"

    def _needsLookup(self, filters, sort, propertyPaths):
        if propertyPaths:
            return True
        if sort and sort.get("type") == "property":
            return True
        return bool(filters.get("propertyFilters"))

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

    def _propertyFilterStages(self, filters):
        stages = []
        for pf in filters.get("propertyFilters") or []:
            valueKey = "_pv.values." + ".".join(pf["path"])
            if pf.get("mode") == "values":
                values = pf.get("values") or []
                if values:
                    stages.append({"$match": {valueKey: {"$in": values}}})
            else:  # range
                cond = {}
                if pf.get("min") is not None:
                    cond["$gte"] = pf["min"]
                if pf.get("max") is not None:
                    cond["$lte"] = pf["max"]
                if cond:
                    stages.append({"$match": {valueKey: cond}})
        return stages

    def _projectStage(self, propertyPaths):
        """Project stub fields + only requested property values; drop
        coordinates and the lookup scratch field."""
        project = {"coordinates": 0, "_pv": 0, "_sortValue": 0,
                   "_hasSortValue": 0}
        if propertyPaths:
            # Re-add a trimmed `values` object holding only requested paths.
            valuesExpr = {}
            for path in propertyPaths:
                # Build nested {p:{Area: "$_pv.values.p.Area"}}
                ref = "$_pv.values." + ".".join(path)
                node = valuesExpr
                for key in path[:-1]:
                    node = node.setdefault(key, {})
                node[path[-1]] = {"$ifNull": [ref, "$$REMOVE"]}
            return [
                {"$addFields": {"values": valuesExpr}},
                {"$project": project},
            ]
        return [{"$project": project}]
```

Replace `_sortStage` to support property sort with missing-to-end, and add a property `$addFields` for the sort value. Update `_sortStage`:

```python
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

    def _propertySortAddFields(self, sort):
        if sort and sort.get("type") == "property":
            ref = "$_pv.values." + ".".join(sort["key"])
            return [{"$addFields": {
                "_sortValue": ref,
                "_hasSortValue": {"$cond": [
                    {"$ne": [{"$ifNull": [ref, None]}, None]}, 1, 0,
                ]},
            }}]
        return []
```

Rewrite `listCount`, `listPage`, and `listIds` to compose the lookup + property stages:

```python
    def _composePipeline(self, datasetId, filters, sort, propertyPaths,
                         include_sort, include_project):
        pipeline = self._buildListMatchStages(datasetId, filters)
        if self._needsLookup(filters, sort, propertyPaths):
            pipeline += self._lookupStages()
            pipeline += self._propertyFilterStages(filters)
        if include_sort:
            pipeline += self._propertySortAddFields(sort)
            pipeline.append(self._centroidAddFields())
            pipeline.append(self._sortStage(sort))
        return pipeline

    def listCount(self, datasetId, filters):
        # Count only needs lookup when a property FILTER is active
        # (sorting never changes the count).
        pipeline = self._buildListMatchStages(datasetId, filters)
        if filters.get("propertyFilters"):
            pipeline += self._lookupStages()
            pipeline += self._propertyFilterStages(filters)
        pipeline.append({"$count": "n"})
        result = list(self.collection.aggregate(
            pipeline, hint={"datasetId": 1, "_id": 1}, allowDiskUse=True
        ))
        return result[0]["n"] if result else 0

    def listPage(self, datasetId, filters, sort, propertyPaths,
                 offset, limit):
        pipeline = self._composePipeline(
            datasetId, filters, sort, propertyPaths,
            include_sort=True, include_project=False,
        )
        pipeline.append({"$skip": max(0, offset)})
        pipeline.append({"$limit": limit})
        pipeline += self._projectStage(propertyPaths)
        return self.collection.aggregate(
            pipeline, hint={"datasetId": 1, "_id": 1}, allowDiskUse=True
        )

    def listIds(self, datasetId, filters):
        pipeline = self._composePipeline(
            datasetId, filters, None, [],
            include_sort=False, include_project=False,
        )
        pipeline.append({"$project": {"_id": 1}})
        cursor = self.collection.aggregate(
            pipeline, hint={"datasetId": 1, "_id": 1}, allowDiskUse=True
        )
        return [str(doc["_id"]) for doc in cursor]
```

(Remove the standalone `_centroidAddFields()` + `_sortStage()` calls left in the old `listPage`/`listIds` from Task 2 — they're now inside `_composePipeline`/`listPage`. The old `listIds` from Task 1 is fully replaced here.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `tox -- upenncontrast_annotation/test/test_server_list.py -v`
Expected: all `TestServerListIds`, `TestServerListPage`, `TestServerListProperties` PASS. flake8 clean.

- [ ] **Step 5: Run the full backend suite (no regressions)**

Run: `cd devops/girder/plugins/AnnotationPlugin && tox`
Expected: all tests PASS, flake8 clean.

- [ ] **Step 6: Commit**

```bash
git add devops/girder/plugins/AnnotationPlugin/upenncontrast_annotation/server/models/annotation.py \
        devops/girder/plugins/AnnotationPlugin/upenncontrast_annotation/test/test_server_list.py
git commit -m "feat(backend): property lookup for list (sort, filter, projected values)"
```

---

## Task 3.5: Backend real-data verification (CHECKPOINT — requires user input)

The pytest/tox tests above use synthetic data. Before building the frontend on these endpoints, validate them against **real datasets and database objects** on the running local backend.

**STOP and ask the user** to point to: (a) a real `datasetId` (ideally a large one, > the 20k guard), (b) a known property path + expected sort order or value range, and (c) known tag/location facts — so results can be checked against ground truth.

- [ ] **Step 1: Ask the user for real objects** (dataset ID, a property path, expected facts to assert against).

- [ ] **Step 2: Exercise the endpoints against the running local Girder.**

Use the `nimbusimage` low-level client (preferred over raw curl — see CLAUDE.md "NimbusImage Python API" + the `nimbus-local-ops` skill). Example:

```python
import os
from dotenv import load_dotenv
from nimbusimage._girder import create_client
load_dotenv()
gc = create_client(
    api_url=os.environ["GIRDER_API_URL"],
    username=os.environ["GIRDER_USERNAME"],
    password=os.environ["GIRDER_PASSWORD"],
)
DATASET_ID = "<<user-provided>>"

# Page 1, sort by a real property, descending
page = gc.post("/upenn_annotation/list", json={
    "datasetId": DATASET_ID,
    "filters": {},
    "sort": {"type": "property", "key": ["<<propId>>", "<<sub>>"],
             "order": "desc"},
    "propertyPaths": [["<<propId>>", "<<sub>>"]],
    "offset": 0, "limit": 50,
})
print(page["total"], len(page["rows"]), page["rows"][0]["values"])

ids = gc.post("/upenn_annotation/list/ids", json={
    "datasetId": DATASET_ID, "filters": {},
})
assert ids["total"] == page["total"]  # ids count must equal page total
```

- [ ] **Step 3: Validate against ground truth** (with the user's expected facts):
  - `total` matches the dataset's annotation count (and the count endpoint) for empty filters.
  - `/list/ids` total == `/list` total for identical filters.
  - Property sort order is correct on real values; missing-value rows land last.
  - A tag filter (inclusive and exclusive) returns the counts the user expects (this is the parity risk — confirm against the client's current list behavior on the same dataset).
  - A property range filter narrows `total` as expected.
  - Spot-check latency on the large dataset (note deep-offset behavior).

- [ ] **Step 4: Record findings** in the PR/commit notes; fix any discrepancies before proceeding to the frontend.

---

## Task 4: Frontend — API client methods + types

**Files:** Modify `src/store/model.ts`, `src/store/AnnotationsAPI.ts`; Test `src/store/AnnotationsAPI.test.ts` (create if absent).

- [ ] **Step 1: Add types to `src/store/model.ts`**

Near `IAnnotationStub` (line ~1391):

```typescript
export interface IAnnotationListSort {
  type: "field" | "property";
  key: string | string[]; // "location.XY" | "name" | ... | ["propId","sub"]
  order: "asc" | "desc";
}

export interface IAnnotationListPropertyFilter {
  path: string[];
  mode: "range" | "values";
  min?: number;
  max?: number;
  values?: number[];
}

export interface IAnnotationListFilters {
  shape?: string;
  tags?: { values: string[]; exclusive: boolean };
  location?: IAnnotationLocation;
  idSubstring?: string;
  propertyFilters?: IAnnotationListPropertyFilter[];
}

export interface IAnnotationListQuery {
  datasetId: string;
  filters: IAnnotationListFilters;
  sort: IAnnotationListSort | null;
  propertyPaths: string[][];
  offset: number;
  limit: number;
}

// A server list row: stub fields + the requested property values.
export interface IAnnotationListRow extends IAnnotationStub {
  values: IAnnotationPropertyValues[string]; // {[propId]: value | nested}
}

export interface IAnnotationListPage {
  total: number;
  rows: IAnnotationListRow[];
}
```

- [ ] **Step 2: Write the failing API-client test**

Create `src/store/AnnotationsAPI.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import AnnotationsAPI from "./AnnotationsAPI";

function makeApi(postImpl: any) {
  const client = { post: vi.fn(postImpl) } as any;
  return { api: new AnnotationsAPI(client), client };
}

describe("AnnotationsAPI.fetchAnnotationListPage", () => {
  it("posts the query and maps rows to stub-shaped objects", async () => {
    const { api, client } = makeApi(async () => ({
      data: {
        total: 1,
        rows: [{
          _id: "a1", tags: ["X"], shape: "polygon", channel: 0,
          location: { XY: 0, Z: 0, Time: 0 }, color: null,
          centroid: { x: 1, y: 2 }, values: { p: { Area: 9 } },
        }],
      },
    }));
    const page = await api.fetchAnnotationListPage({
      datasetId: "ds", filters: {}, sort: null,
      propertyPaths: [["p", "Area"]], offset: 0, limit: 50,
    });
    expect(client.post).toHaveBeenCalledWith(
      "upenn_annotation/list", expect.objectContaining({ datasetId: "ds" }),
    );
    expect(page.total).toBe(1);
    expect(page.rows[0].id).toBe("a1");
    expect(page.rows[0].values.p.Area).toBe(9);
  });
});

describe("AnnotationsAPI.fetchAnnotationListIds", () => {
  it("returns the id array", async () => {
    const { api } = makeApi(async () => ({
      data: { total: 2, ids: ["a", "b"] },
    }));
    const ids = await api.fetchAnnotationListIds("ds", {});
    expect(ids).toEqual(["a", "b"]);
  });
});
```

- [ ] **Step 2b: Run to verify failure**

Run: `pnpm exec vitest run src/store/AnnotationsAPI.test.ts`
Expected: FAIL — methods undefined.

- [ ] **Step 3: Implement the methods**

In `src/store/AnnotationsAPI.ts` add imports for the new types and add methods (after `getAnnotationStubs`). Reuse the existing `markRaw` import:

```typescript
  toListRow = (item: any): IAnnotationListRow => {
    const stub = this.toStub(item);
    return markRaw({ ...stub, values: item.values || {} });
  };

  async fetchAnnotationListPage(
    query: IAnnotationListQuery,
  ): Promise<IAnnotationListPage> {
    const response = await this.client.post("upenn_annotation/list", query);
    return {
      total: response.data.total,
      rows: (response.data.rows as any[]).map(this.toListRow),
    };
  }

  async fetchAnnotationListIds(
    datasetId: string,
    filters: IAnnotationListFilters,
  ): Promise<string[]> {
    const response = await this.client.post("upenn_annotation/list/ids", {
      datasetId,
      filters,
    });
    return response.data.ids as string[];
  }
```

Add to the import block at the top of `AnnotationsAPI.ts`:
```typescript
import {
  // ...existing...
  IAnnotationListQuery,
  IAnnotationListPage,
  IAnnotationListRow,
  IAnnotationListFilters,
} from "./model";
```

- [ ] **Step 4: Run tests + tsc**

Run: `pnpm exec vitest run src/store/AnnotationsAPI.test.ts && pnpm tsc`
Expected: PASS, 0 type errors.

- [ ] **Step 5: Commit**

```bash
git add src/store/model.ts src/store/AnnotationsAPI.ts src/store/AnnotationsAPI.test.ts
git commit -m "feat(frontend): annotation list API client methods + types"
```

---

## Task 5: Frontend — `annotationListServer` Vuex module

Owns server-mode list state and the fetch (reads filters from `filterStore`, displayed columns from `propertyStore`). Keeps `annotation.ts`/`filters.ts` from growing.

**Files:** Create `src/store/annotationListServer.ts`, `src/store/__tests__/annotationListServer.test.ts`.

- [ ] **Step 1: Write the failing test**

Create `src/store/__tests__/annotationListServer.test.ts`. Mirror the plain-Vuex test approach used in `annotationStubs.test.ts` (don't import the real module's dependencies). Test the **filter-translation** pure helper and the page-state reducer, which are the logic worth pinning:

```typescript
import { describe, it, expect } from "vitest";
import { buildListFilters } from "../annotationListServer";

describe("buildListFilters", () => {
  it("translates an enabled tag filter (inclusive)", () => {
    const filters = buildListFilters({
      tagFilter: { enabled: true, exclusive: false, tags: ["A", "B"] },
      onlyCurrentFrame: false,
      currentFrame: { XY: 0, Z: 0, Time: 0 },
      idSubstring: "",
      propertyFilters: [],
    });
    expect(filters.tags).toEqual({ values: ["A", "B"], exclusive: false });
    expect(filters.location).toBeUndefined();
  });

  it("includes location when onlyCurrentFrame is set", () => {
    const filters = buildListFilters({
      tagFilter: { enabled: false, exclusive: false, tags: [] },
      onlyCurrentFrame: true,
      currentFrame: { XY: 2, Z: 1, Time: 0 },
      idSubstring: "",
      propertyFilters: [],
    });
    expect(filters.location).toEqual({ XY: 2, Z: 1, Time: 0 });
  });

  it("translates a property range filter", () => {
    const filters = buildListFilters({
      tagFilter: { enabled: false, exclusive: false, tags: [] },
      onlyCurrentFrame: false,
      currentFrame: { XY: 0, Z: 0, Time: 0 },
      idSubstring: "abc",
      propertyFilters: [
        { propertyPath: ["p", "Area"], valuesOrRange: "range",
          range: { min: 1, max: 5 }, values: [] },
      ],
    });
    expect(filters.idSubstring).toBe("abc");
    expect(filters.propertyFilters).toEqual([
      { path: ["p", "Area"], mode: "range", min: 1, max: 5 },
    ]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run src/store/__tests__/annotationListServer.test.ts`
Expected: FAIL — `buildListFilters` not exported.

- [ ] **Step 3: Implement the module + pure helper**

Create `src/store/annotationListServer.ts`:

```typescript
import {
  getModule, Action, Module, Mutation, VuexModule,
} from "vuex-module-decorators";
import store from "./root";
import { markRaw } from "vue";

import main from "./index";
import filters from "./filters";
import properties from "./properties";
import {
  IAnnotationListRow, IAnnotationListSort, IAnnotationListFilters,
  ITagAnnotationFilter, IPropertyAnnotationFilter, IAnnotationLocation,
} from "./model";

// Pure: translate the client filter store into backend list filters.
export function buildListFilters(input: {
  tagFilter: ITagAnnotationFilter;
  onlyCurrentFrame: boolean;
  currentFrame: IAnnotationLocation;
  idSubstring: string;
  propertyFilters: IPropertyAnnotationFilter[];
}): IAnnotationListFilters {
  const out: IAnnotationListFilters = {};
  if (input.tagFilter.enabled && input.tagFilter.tags.length > 0) {
    out.tags = {
      values: input.tagFilter.tags,
      exclusive: input.tagFilter.exclusive,
    };
  }
  if (input.onlyCurrentFrame) {
    out.location = { ...input.currentFrame };
  }
  if (input.idSubstring) {
    out.idSubstring = input.idSubstring;
  }
  const pfs = input.propertyFilters
    .filter((f) => f.enabled)
    .map((f) =>
      f.valuesOrRange === "values"
        ? { path: f.propertyPath, mode: "values" as const, values: f.values }
        : {
            path: f.propertyPath, mode: "range" as const,
            min: f.range.min, max: f.range.max,
          },
    );
  if (pfs.length > 0) {
    out.propertyFilters = pfs;
  }
  return out;
}

@Module({ dynamic: true, store, name: "annotationListServer" })
export class AnnotationListServer extends VuexModule {
  rows: IAnnotationListRow[] = markRaw([]);
  total = 0;
  loading = false;
  page = 1; // 1-based (Vuetify)
  pageSize = 50;
  sort: IAnnotationListSort | null = null;
  idSubstring = "";

  @Mutation
  setPageResult(payload: { rows: IAnnotationListRow[]; total: number }) {
    this.rows = markRaw(payload.rows);
    this.total = payload.total;
  }

  @Mutation
  setLoading(value: boolean) {
    this.loading = value;
  }

  @Mutation
  setOptions(payload: {
    page?: number; pageSize?: number; sort?: IAnnotationListSort | null;
  }) {
    if (payload.page !== undefined) this.page = payload.page;
    if (payload.pageSize !== undefined) this.pageSize = payload.pageSize;
    if (payload.sort !== undefined) this.sort = payload.sort;
  }

  @Mutation
  setIdSubstring(value: string) {
    this.idSubstring = value;
  }

  get currentFilters(): IAnnotationListFilters {
    return buildListFilters({
      tagFilter: filters.tagFilter,
      onlyCurrentFrame: filters.onlyCurrentFrame,
      currentFrame: { XY: main.xy, Z: main.z, Time: main.time },
      idSubstring: this.idSubstring,
      propertyFilters: filters.propertyFilters,
    });
  }

  @Action
  async fetchPage() {
    const datasetId = main.dataset?.id;
    if (!datasetId) return;
    this.setLoading(true);
    try {
      const page = await main.annotationsAPI.fetchAnnotationListPage({
        datasetId,
        filters: this.currentFilters,
        sort: this.sort,
        propertyPaths: properties.displayedPropertyPaths,
        offset: (this.page - 1) * this.pageSize,
        limit: this.pageSize,
      });
      this.setPageResult(page);
    } finally {
      this.setLoading(false);
    }
  }

  @Action
  async fetchMatchingIds(): Promise<string[]> {
    const datasetId = main.dataset?.id;
    if (!datasetId) return [];
    return main.annotationsAPI.fetchAnnotationListIds(
      datasetId, this.currentFilters,
    );
  }
}

export default getModule(AnnotationListServer);

if (import.meta.hot) {
  import.meta.hot.accept();
}
```

Note: confirm `main.annotationsAPI` is the correct accessor (same one `annotation.ts` uses — it reads `this.annotationsAPI = main.annotationsAPI`). If the property differs, match the existing accessor in `annotation.ts`.

- [ ] **Step 4: Run tests + tsc**

Run: `pnpm exec vitest run src/store/__tests__/annotationListServer.test.ts && pnpm tsc`
Expected: 3 tests PASS, 0 type errors.

- [ ] **Step 5: Commit**

```bash
git add src/store/annotationListServer.ts src/store/__tests__/annotationListServer.test.ts
git commit -m "feat(frontend): annotationListServer store module + filter translation"
```

---

## Task 6: Frontend — wire `AnnotationList.vue` to server mode (dual-mode)

**Files:** Modify `src/components/AnnotationBrowser/AnnotationList.vue`, `src/components/AnnotationBrowser/AnnotationList.test.ts`.

- [ ] **Step 1: Write the failing test**

Append to `AnnotationList.test.ts`. Add a mock for the new module near the other `vi.mock` blocks:

```typescript
const mockFetchPage = vi.fn();
vi.mock("@/store/annotationListServer", () => {
  const state = {
    rows: [], total: 0, loading: false, page: 1, pageSize: 50, sort: null,
    setOptions: vi.fn(),
    fetchPage: (...a: any[]) => mockFetchPage(...a),
    fetchMatchingIds: vi.fn(async () => []),
    setIdSubstring: vi.fn(),
  };
  return { default: state };
});
```

Add a test (inside the main describe):

```typescript
describe("server mode", () => {
  it("uses server rows + total and fetches on mount when stubOnlyMode", () => {
    (annotationStore as any).stubOnlyMode = true;
    const serverStore = (await import("@/store/annotationListServer")).default as any;
    serverStore.rows = [{
      id: "s1", tags: [], shape: "point", channel: 0,
      location: { XY: 0, Z: 0, Time: 0 }, color: null,
      centroid: { x: 0, y: 0 }, values: {},
    }];
    serverStore.total = 1234;
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    expect(vm.isServerMode).toBe(true);
    expect(vm.serverItemsLength).toBe(1234);
    expect(mockFetchPage).toHaveBeenCalled();
  });
});
```

(Set `(annotationStore as any).stubOnlyMode = false;` in the `beforeEach` reset block so other tests stay in client mode. Make the test function `async` to use the dynamic import, or import the mocked module at top instead.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run src/components/AnnotationBrowser/AnnotationList.test.ts`
Expected: FAIL — `isServerMode` / `serverItemsLength` undefined.

- [ ] **Step 3: Implement dual-mode in the component**

In `AnnotationList.vue` `<script setup>`:

```typescript
import annotationListServer from "@/store/annotationListServer";
import { watch, onMounted } from "vue"; // merge with existing vue imports

const isServerMode = computed(() => annotationStore.stubOnlyMode);
const serverRows = computed(() => annotationListServer.rows);
const serverItemsLength = computed(() => annotationListServer.total);
const serverLoading = computed(() => annotationListServer.loading);

// ROI filters can't run server-side yet.
const roiActiveInServerMode = computed(
  () => isServerMode.value && filterStore.roiFilters.some((f) => f.enabled),
);

function onServerOptions(opts: {
  page: number;
  itemsPerPage: number;
  sortBy: { key: string; order: "asc" | "desc" }[];
}) {
  const sortEntry = opts.sortBy[0];
  annotationListServer.setOptions({
    page: opts.page,
    pageSize: opts.itemsPerPage,
    sort: sortEntry ? mapSort(sortEntry) : null,
  });
  annotationListServer.fetchPage();
}

// Map a Vuetify sort key to the backend sort descriptor.
function mapSort(entry: { key: string; order: "asc" | "desc" }): IAnnotationListSort {
  if (entry.key.startsWith("properties.")) {
    return {
      type: "property",
      key: entry.key.slice("properties.".length).split("."),
      order: entry.order,
    };
  }
  // strip the "annotation." prefix the columns use
  const fieldKey = entry.key.replace(/^annotation\./, "");
  return { type: "field", key: fieldKey, order: entry.order };
}

// Keep the server idSubstring in sync with the existing localIdFilter box.
watch(localIdFilter, (v) => {
  if (isServerMode.value) {
    annotationListServer.setIdSubstring(v?.trim() || "");
    annotationListServer.setOptions({ page: 1 });
    annotationListServer.fetchPage();
  }
});

// Re-fetch when filters/frame/displayed columns change in server mode.
watch(
  () => [
    filterStore.tagFilter, filterStore.propertyFilters,
    filterStore.onlyCurrentFrame, propertyStore.displayedPropertyPaths,
    store.xy, store.z, store.time,
  ],
  () => {
    if (isServerMode.value) {
      annotationListServer.setOptions({ page: 1 });
      annotationListServer.fetchPage();
    }
  },
  { deep: true },
);

onMounted(() => {
  if (isServerMode.value) annotationListServer.fetchPage();
});
```

Add `IAnnotationListSort` to the `@/store/model` import. Expose the new computeds/functions in `defineExpose` (`isServerMode`, `serverItemsLength`, `serverRows`, `serverLoading`, `roiActiveInServerMode`, `onServerOptions`, `mapSort`).

In the template, replace the single `<v-data-table>` block with a mode switch. Keep the existing client table as the `v-else`; add the server table + ROI notice:

```html
<v-alert
  v-if="roiActiveInServerMode"
  type="info" density="compact" variant="tonal" class="mb-2"
>
  ROI filtering isn't available for very large datasets yet — it's ignored
  in this list. Other filters still apply.
</v-alert>

<v-data-table-server
  v-if="isServerMode"
  :items="serverRowItems"
  :items-length="serverItemsLength"
  :loading="serverLoading"
  :headers="headers"
  :items-per-page="annotationListServer.pageSize"
  :items-per-page-options="[10, 50, 200]"
  show-select
  density="compact"
  item-value="annotation.id"
  v-model="selectedIds"
  @update:options="onServerOptions"
  class="compact-table"
>
  <!-- Copy the existing client table's header.data-table-select,
       header.${header.key}, and item slots VERBATIM into here. No edits
       needed: serverRowItems produces the identical item shape
       ({annotation, index, shapeName, isSelected, properties}), and
       item.index is already (offset + rowIndex) from serverRowItems, so the
       Index column cell renders correctly without change. -->
</v-data-table-server>
```

Add a `serverRowItems` computed that adapts server rows to the existing item shape (so the row slot markup is shared):

```typescript
const serverRowItems = computed(() =>
  serverRows.value.map((row, i) => ({
    annotation: row, // stub-shaped: has id/tags/shape/location/centroid
    index:
      (annotationListServer.page - 1) * annotationListServer.pageSize + i,
    shapeName: AnnotationNames[row.shape],
    isSelected: annotationStore.isAnnotationSelected(row.id),
    properties: row.values || {},
  })),
);
```

Keep `tooManyToList` (Task A guard) active **only in client mode** — when `isServerMode` is true the server handles scale, so guard the existing block with `v-if="!isServerMode && tooManyToList"` and gate the client `<v-data-table>` with `v-if="!isServerMode && !tooManyToList"`.

- [ ] **Step 4: Run tests + tsc + lint**

Run: `pnpm exec vitest run src/components/AnnotationBrowser/AnnotationList.test.ts && pnpm tsc && pnpm exec eslint src/components/AnnotationBrowser/AnnotationList.vue`
Expected: PASS, 0 type errors, 0 new lint errors.

- [ ] **Step 5: Commit**

```bash
git add src/components/AnnotationBrowser/AnnotationList.vue src/components/AnnotationBrowser/AnnotationList.test.ts
git commit -m "feat(frontend): dual-mode AnnotationList with server-items rendering"
```

---

## Task 7: Frontend — Select All / Delete Unselected via matching-IDs in server mode

**Files:** Modify `src/components/AnnotationBrowser/AnnotationList.vue`, `AnnotationList.test.ts`.

- [ ] **Step 1: Write the failing test**

Append to `AnnotationList.test.ts`:

```typescript
describe("server-mode select all", () => {
  it("populates selection from fetchMatchingIds", async () => {
    (annotationStore as any).stubOnlyMode = true;
    const serverStore =
      (await import("@/store/annotationListServer")).default as any;
    serverStore.fetchMatchingIds = vi.fn(async () => ["a", "b", "c"]);
    const wrapper = mountComponent();
    const vm = wrapper.vm as any;
    await vm.selectAllCallback();
    expect(mockSetSelected).toHaveBeenCalledWith(["a", "b", "c"]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run src/components/AnnotationBrowser/AnnotationList.test.ts -t "server-mode select all"`
Expected: FAIL — `selectAllCallback` selects from `filteredItems`, not the server IDs.

- [ ] **Step 3: Implement**

In `AnnotationList.vue`, make `selectAllCallback` async and branch on mode:

```typescript
async function selectAllCallback() {
  if (selectAllValue.value) {
    selectedIds.value = [];
    return;
  }
  if (isServerMode.value) {
    selectedIds.value = await annotationListServer.fetchMatchingIds();
  } else {
    selectedIds.value = filteredItems.value.map((item) => item.annotation.id);
  }
}
```

Update `deleteUnselected` for server mode (fetch all matching IDs, subtract the explicit selection, delete the remainder). Add an action on the annotation store or compute inline:

```typescript
async function deleteUnselected() {
  if (isServerMode.value) {
    const all = await annotationListServer.fetchMatchingIds();
    const selected = new Set(annotationStore.selectedAnnotationIds);
    const toDelete = all.filter((id) => !selected.has(id));
    await annotationStore.deleteAnnotations(toDelete); // existing batch action
    return;
  }
  annotationStore.deleteUnselectedAnnotations();
}
```

Confirm the exact batch-delete action name in `annotation.ts` (`deleteAnnotations` vs `deleteMultipleAnnotations`); use whichever the store exposes for "delete this list of ids". `selectAllValue`/`selectAllIndeterminate` should use `serverItemsLength` in server mode — update them:

```typescript
const selectAllValue = computed(() => {
  if (isServerMode.value) {
    return serverItemsLength.value > 0 &&
      annotationStore.selectedAnnotationIds.size === serverItemsLength.value;
  }
  return selectedItems.value.length === filteredItems.value.length;
});
```

- [ ] **Step 4: Run tests + tsc + lint**

Run: `pnpm exec vitest run src/components/AnnotationBrowser/AnnotationList.test.ts && pnpm tsc`
Expected: PASS, 0 type errors.

- [ ] **Step 5: Run the full frontend suite (no regressions)**

Run: `pnpm test`
Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/AnnotationBrowser/AnnotationList.vue src/components/AnnotationBrowser/AnnotationList.test.ts
git commit -m "feat(frontend): server-mode Select All / Delete Unselected via matching-ids"
```

---

## Final verification

- [ ] Backend: `cd devops/girder/plugins/AnnotationPlugin && tox` — all green, flake8 clean.
- [ ] Frontend: `pnpm tsc && pnpm test && pnpm exec eslint src/store/annotationListServer.ts src/store/AnnotationsAPI.ts src/components/AnnotationBrowser/AnnotationList.vue` — green, no new errors.
- [ ] Manual (real app, large dataset > guard): list paginates, sorts by a property column (missing values last), property/tag/location filters narrow results + total, ROI filter shows the notice, Select All → Delete works, switching to a small dataset still uses the client list unchanged.
- [ ] Update `ANNOTATION-STUBS.md`: mark Option B implemented; restate the deferred items (infinite scroll, server-side ROI, per-property indexes, other propertyValues consumers).

---

## Notes & risks (carried from the spec)

- **Deep-offset `$skip`** is slow at very large offsets — acceptable for v1; infinite-scroll is the planned follow-up.
- **No per-property index** — `$lookup`+`$unwind` over a dataset's property values is the cost; add sparse `(datasetId, "values.<propertyId>")` indexes + bidirectional query only if profiling demands it.
- **Tag-semantics parity** is pinned by `testListIdsFilterByTags*` — keep these green; they're what makes the dual-mode switch seamless.
- **`v-data-table-server`** is the Vuetify 4 server component; confirm it's available in the project's Vuetify version. If the team prefers, the existing `v-data-table` can be driven in server mode via `:items-length` + `@update:options` instead — adjust Task 6 accordingly.

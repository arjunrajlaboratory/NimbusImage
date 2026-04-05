# Backend Security Audit Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all identified access control vulnerabilities in the Girder backend plugin and add comprehensive security tests.

**Architecture:** Add dataset-level WRITE access checks to all write endpoints that currently lack them. Add `datasetId` parameter to bulk delete endpoints. Restrict admin-only endpoints. All fixes follow the existing pattern: `Folder().load(datasetId, user=self.getCurrentUser(), level=AccessType.WRITE, exc=True)`.

**Tech Stack:** Python/Girder backend, pytest with pytest_girder fixtures, tox for test runner, Docker Compose for rebuild/deploy.

**Testing approach:** All security tests are HTTP-level tests using the `server` fixture (same pattern as `test_counts.py` and `test_sharing.py`). Tests create resources as `admin` in admin's Private folder, then attempt unauthorized operations as `user`. Private folders are inaccessible by default to other users.

**Build/test cycle:** After each group of backend changes:
```bash
cd devops/girder/plugins/AnnotationPlugin && tox
```

**Frontend changes:** After all backend fixes, update `src/store/AnnotationsAPI.ts` to pass `datasetId` to the modified bulk delete endpoints.

---

## File Map

### Files to Create
- `devops/girder/plugins/AnnotationPlugin/upenncontrast_annotation/test/test_access_control.py` — All new security tests

### Files to Modify (Backend)
- `devops/girder/plugins/AnnotationPlugin/upenncontrast_annotation/server/api/annotation.py` — Add dataset WRITE checks to create, createMultiple, deleteMultiple
- `devops/girder/plugins/AnnotationPlugin/upenncontrast_annotation/server/api/connections.py` — Add dataset WRITE checks to create, multipleCreate, deleteMultiple; require datasetId on find
- `devops/girder/plugins/AnnotationPlugin/upenncontrast_annotation/server/api/propertyValues.py` — Add dataset WRITE checks to add, addMultiple, delete; add READ check to histogram
- `devops/girder/plugins/AnnotationPlugin/upenncontrast_annotation/server/api/export.py` — Replace force=True with user-level access check in _getProperties
- `devops/girder/plugins/AnnotationPlugin/upenncontrast_annotation/server/api/history.py` — Add dataset access checks to find, undo, redo
- `devops/girder/plugins/AnnotationPlugin/upenncontrast_annotation/server/api/workerInterfaces.py` — Change update to @access.admin
- `devops/girder/plugins/AnnotationPlugin/upenncontrast_annotation/server/api/workerPreviews.py` — Change update and clearImagePreview to @access.admin
- `devops/girder/plugins/AnnotationPlugin/upenncontrast_annotation/server/api/user_assetstore.py` — Change find to @access.admin

### Files to Modify (Frontend)
- `src/store/AnnotationsAPI.ts` — Pass datasetId to deleteMultipleAnnotations and deleteMultipleConnections
- `src/store/annotation.ts` — Pass datasetId through to AnnotationsAPI calls
- `src/utils/annotationImport.ts` — Pass datasetId to deleteMultipleAnnotations

---

## Task 1: Write All Security Tests (Expected to Fail)

**Files:**
- Create: `devops/girder/plugins/AnnotationPlugin/upenncontrast_annotation/test/test_access_control.py`

- [ ] **Step 1: Write the test file with all security tests**

```python
"""
Security tests for access control on all plugin endpoints.

All tests create resources as admin in admin's Private folder,
then attempt unauthorized operations as user (who has no access).
"""
import json

import pytest
from bson.objectid import ObjectId

from pytest_girder.assertions import assertStatus, assertStatusOk

from upenncontrast_annotation.server.models.annotation import Annotation
from upenncontrast_annotation.server.models.connections import (
    AnnotationConnection,
)
from upenncontrast_annotation.server.models.propertyValues import (
    AnnotationPropertyValues,
)
from upenncontrast_annotation.server.models.collection import Collection
from upenncontrast_annotation.server.models.datasetView import DatasetView

from . import girder_utilities as utilities
from . import upenn_testing_utilities as upenn_utilities


def getDefaultConfigMetadata():
    return {
        "subtype": "contrastConfiguration",
        "compatibility": {},
        "layers": [],
        "tools": [],
        "propertyIds": [],
        "snapshots": [],
        "scales": {},
    }


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestAnnotationAccessControl:
    """Test that annotation endpoints enforce dataset access."""

    def testCreateAnnotationDeniedWithoutAccess(
        self, admin, user, server
    ):
        """User cannot create annotation in admin's private dataset."""
        folder = utilities.createPrivateFolder(
            admin, "private_ds", upenn_utilities.datasetMetadata
        )
        annotation = upenn_utilities.getSampleAnnotation(
            str(folder["_id"])
        )
        resp = server.request(
            path="/upenn_annotation",
            method="POST",
            user=user,
            body=json.dumps(annotation),
            type="application/json",
        )
        assertStatus(resp, 403)

    def testCreateMultipleAnnotationsDeniedWithoutAccess(
        self, admin, user, server
    ):
        """User cannot bulk-create annotations in admin's dataset."""
        folder = utilities.createPrivateFolder(
            admin, "private_ds", upenn_utilities.datasetMetadata
        )
        annotations = [
            upenn_utilities.getSampleAnnotation(str(folder["_id"]))
            for _ in range(3)
        ]
        resp = server.request(
            path="/upenn_annotation/multiple",
            method="POST",
            user=user,
            body=json.dumps(annotations),
            type="application/json",
        )
        assertStatus(resp, 403)

    def testDeleteMultipleAnnotationsDeniedWithoutAccess(
        self, admin, user, server
    ):
        """User cannot bulk-delete annotations in admin's dataset."""
        folder = utilities.createPrivateFolder(
            admin, "private_ds", upenn_utilities.datasetMetadata
        )
        ann = Annotation().create(
            upenn_utilities.getSampleAnnotation(folder["_id"])
        )
        resp = server.request(
            path="/upenn_annotation/multiple",
            method="DELETE",
            user=user,
            body=json.dumps([str(ann["_id"])]),
            type="application/json",
            params={"datasetId": str(folder["_id"])},
        )
        assertStatus(resp, 403)

    def testDeleteMultipleAnnotationsAllowedWithAccess(
        self, admin, server
    ):
        """Owner can bulk-delete their own annotations."""
        folder = utilities.createPrivateFolder(
            admin, "private_ds", upenn_utilities.datasetMetadata
        )
        ann = Annotation().create(
            upenn_utilities.getSampleAnnotation(folder["_id"])
        )
        resp = server.request(
            path="/upenn_annotation/multiple",
            method="DELETE",
            user=admin,
            body=json.dumps([str(ann["_id"])]),
            type="application/json",
            params={"datasetId": str(folder["_id"])},
        )
        assertStatusOk(resp)


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestConnectionAccessControl:
    """Test that connection endpoints enforce dataset access."""

    def testCreateConnectionDeniedWithoutAccess(
        self, admin, user, server
    ):
        """User cannot create connection in admin's private dataset."""
        folder = utilities.createPrivateFolder(
            admin, "private_ds", upenn_utilities.datasetMetadata
        )
        ann1 = Annotation().create(
            upenn_utilities.getSampleAnnotation(folder["_id"])
        )
        ann2 = Annotation().create(
            upenn_utilities.getSampleAnnotation(folder["_id"])
        )
        connection = upenn_utilities.getSampleConnection(
            str(ann1["_id"]), str(ann2["_id"]), str(folder["_id"])
        )
        resp = server.request(
            path="/annotation_connection",
            method="POST",
            user=user,
            body=json.dumps(connection),
            type="application/json",
        )
        assertStatus(resp, 403)

    def testCreateMultipleConnectionsDeniedWithoutAccess(
        self, admin, user, server
    ):
        """User cannot bulk-create connections in admin's dataset."""
        folder = utilities.createPrivateFolder(
            admin, "private_ds", upenn_utilities.datasetMetadata
        )
        ann1 = Annotation().create(
            upenn_utilities.getSampleAnnotation(folder["_id"])
        )
        ann2 = Annotation().create(
            upenn_utilities.getSampleAnnotation(folder["_id"])
        )
        connections = [
            upenn_utilities.getSampleConnection(
                str(ann1["_id"]), str(ann2["_id"]), str(folder["_id"])
            )
        ]
        resp = server.request(
            path="/annotation_connection/multiple",
            method="POST",
            user=user,
            body=json.dumps(connections),
            type="application/json",
        )
        assertStatus(resp, 403)

    def testDeleteMultipleConnectionsDeniedWithoutAccess(
        self, admin, user, server
    ):
        """User cannot bulk-delete connections in admin's dataset."""
        folder = utilities.createPrivateFolder(
            admin, "private_ds", upenn_utilities.datasetMetadata
        )
        ann1 = Annotation().create(
            upenn_utilities.getSampleAnnotation(folder["_id"])
        )
        ann2 = Annotation().create(
            upenn_utilities.getSampleAnnotation(folder["_id"])
        )
        conn = AnnotationConnection().create(
            upenn_utilities.getSampleConnection(
                ann1["_id"], ann2["_id"], folder["_id"]
            )
        )
        resp = server.request(
            path="/annotation_connection/multiple",
            method="DELETE",
            user=user,
            body=json.dumps([str(conn["_id"])]),
            type="application/json",
            params={"datasetId": str(folder["_id"])},
        )
        assertStatus(resp, 403)

    def testFindConnectionsRequiresDatasetId(self, admin, server):
        """Find connections without datasetId should be rejected."""
        resp = server.request(
            path="/annotation_connection",
            method="GET",
            user=admin,
        )
        assertStatus(resp, 400)


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestPropertyValuesAccessControl:
    """Test that property value endpoints enforce dataset access."""

    def testAddPropertyValueDeniedWithoutAccess(
        self, admin, user, server
    ):
        """User cannot add property values in admin's dataset."""
        folder = utilities.createPrivateFolder(
            admin, "private_ds", upenn_utilities.datasetMetadata
        )
        ann = Annotation().create(
            upenn_utilities.getSampleAnnotation(folder["_id"])
        )
        resp = server.request(
            path="/annotation_property_values",
            method="POST",
            user=user,
            body=json.dumps({"testProp": 42}),
            type="application/json",
            params={
                "annotationId": str(ann["_id"]),
                "datasetId": str(folder["_id"]),
            },
        )
        assertStatus(resp, 403)

    def testAddMultiplePropertyValuesDeniedWithoutAccess(
        self, admin, user, server
    ):
        """User cannot bulk-add property values in admin's dataset."""
        folder = utilities.createPrivateFolder(
            admin, "private_ds", upenn_utilities.datasetMetadata
        )
        ann = Annotation().create(
            upenn_utilities.getSampleAnnotation(folder["_id"])
        )
        entries = [{
            "annotationId": str(ann["_id"]),
            "datasetId": str(folder["_id"]),
            "values": {"testProp": 42},
        }]
        resp = server.request(
            path="/annotation_property_values/multiple",
            method="POST",
            user=user,
            body=json.dumps(entries),
            type="application/json",
        )
        assertStatus(resp, 403)

    def testDeletePropertyValuesDeniedWithoutAccess(
        self, admin, user, server
    ):
        """User cannot delete property values in admin's dataset."""
        folder = utilities.createPrivateFolder(
            admin, "private_ds", upenn_utilities.datasetMetadata
        )
        resp = server.request(
            path="/annotation_property_values",
            method="DELETE",
            user=user,
            params={
                "propertyId": str(ObjectId()),
                "datasetId": str(folder["_id"]),
            },
        )
        assertStatus(resp, 403)

    def testHistogramDeniedWithoutAccess(
        self, admin, user, server
    ):
        """User cannot get histogram for admin's private dataset."""
        folder = utilities.createPrivateFolder(
            admin, "private_ds", upenn_utilities.datasetMetadata
        )
        resp = server.request(
            path="/annotation_property_values/histogram",
            method="GET",
            user=user,
            params={
                "propertyPath": str(ObjectId()),
                "datasetId": str(folder["_id"]),
            },
        )
        assertStatus(resp, 403)


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestExportAccessControl:
    """Test that export respects configuration access."""

    def testExportJsonDeniedForInaccessibleConfig(
        self, admin, user, server
    ):
        """User with dataset READ cannot export using an
        inaccessible configuration."""
        # Create a public dataset (user can READ)
        folder = utilities.createFolder(
            admin, "public_ds", upenn_utilities.datasetMetadata
        )
        # Create a private configuration (user cannot READ)
        configMeta = getDefaultConfigMetadata()
        configMeta["propertyIds"] = ["prop1"]
        private_folder = utilities.createPrivateFolder(
            admin, "private_config_parent",
            upenn_utilities.datasetMetadata
        )
        config = Collection().createCollection(
            "PrivateConfig", admin, private_folder, configMeta
        )

        resp = server.request(
            path="/export/json",
            method="GET",
            user=user,
            params={
                "datasetId": str(folder["_id"]),
                "configurationId": str(config["_id"]),
            },
        )
        assertStatus(resp, 403)


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestHistoryAccessControl:
    """Test that history endpoints enforce dataset access."""

    def testHistoryFindDeniedWithoutAccess(
        self, admin, user, server
    ):
        """User cannot view history for admin's private dataset."""
        folder = utilities.createPrivateFolder(
            admin, "private_ds", upenn_utilities.datasetMetadata
        )
        resp = server.request(
            path="/history",
            method="GET",
            user=user,
            params={"datasetId": str(folder["_id"])},
        )
        assertStatus(resp, 403)

    def testHistoryUndoDeniedWithoutAccess(
        self, admin, user, server
    ):
        """User cannot undo in admin's private dataset."""
        folder = utilities.createPrivateFolder(
            admin, "private_ds", upenn_utilities.datasetMetadata
        )
        resp = server.request(
            path="/history/undo",
            method="PUT",
            user=user,
            params={"datasetId": str(folder["_id"])},
        )
        assertStatus(resp, 403)

    def testHistoryRedoDeniedWithoutAccess(
        self, admin, user, server
    ):
        """User cannot redo in admin's private dataset."""
        folder = utilities.createPrivateFolder(
            admin, "private_ds", upenn_utilities.datasetMetadata
        )
        resp = server.request(
            path="/history/redo",
            method="PUT",
            user=user,
            params={"datasetId": str(folder["_id"])},
        )
        assertStatus(resp, 403)


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestWorkerInterfacesAccessControl:
    """Test that worker interface write endpoints require admin."""

    def testUpdateWorkerInterfaceDeniedForNonAdmin(
        self, user, server
    ):
        """Non-admin user cannot update worker interfaces."""
        resp = server.request(
            path="/worker_interface",
            method="POST",
            user=user,
            body=json.dumps({"test": "data"}),
            type="application/json",
            params={"image": "test-image:latest"},
        )
        assertStatus(resp, 403)


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestWorkerPreviewsAccessControl:
    """Test that worker preview write endpoints require admin."""

    def testUpdatePreviewDeniedForNonAdmin(self, user, server):
        """Non-admin user cannot update worker previews."""
        resp = server.request(
            path="/worker_preview",
            method="POST",
            user=user,
            body=json.dumps({"test": "data"}),
            type="application/json",
            params={"image": "test-image:latest"},
        )
        assertStatus(resp, 403)

    def testClearPreviewDeniedForNonAdmin(self, user, server):
        """Non-admin user cannot clear worker previews."""
        resp = server.request(
            path="/worker_preview",
            method="DELETE",
            user=user,
            params={"image": "test-image:latest"},
        )
        assertStatus(resp, 403)


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestUserAssetstoreAccessControl:
    """Test that assetstore listing requires admin."""

    def testListAssetstoresDeniedForNonAdmin(self, user, server):
        """Non-admin user cannot list assetstores."""
        resp = server.request(
            path="/user_assetstore",
            method="GET",
            user=user,
        )
        assertStatus(resp, 403)
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd devops/girder/plugins/AnnotationPlugin && tox
```

Expected: Most new tests FAIL (they return 200 where we expect 403, or succeed where they should be denied). Existing tests should still pass.

---

## Task 2: Fix Annotation Endpoints

**Files:**
- Modify: `devops/girder/plugins/AnnotationPlugin/upenncontrast_annotation/server/api/annotation.py`

- [ ] **Step 1: Add dataset WRITE check to `create`**

In `annotation.py`, add a dataset WRITE check in the `create` method (after line 88, before calling `self._annotationModel.create`):

```python
def create(self, params, *args, **kwargs):
    bodyJson = kwargs["memoizedBodyJson"]
    annotation = self._annotationModel.convertIdsToObjectIds(bodyJson)
    Folder().load(
        annotation["datasetId"],
        user=self.getCurrentUser(),
        level=AccessType.WRITE,
        exc=True,
    )
    return self._annotationModel.create(annotation)
```

- [ ] **Step 2: Add dataset WRITE check to `createMultiple`**

Same pattern in `createMultiple`:

```python
def createMultiple(self, params, *args, **kwargs):
    bodyJson = kwargs["memoizedBodyJson"]
    annotations = self._annotationModel.convertIdsToObjectIds(bodyJson)
    if annotations:
        Folder().load(
            annotations[0]["datasetId"],
            user=self.getCurrentUser(),
            level=AccessType.WRITE,
            exc=True,
        )
    return self._annotationModel.createMultiple(annotations)
```

- [ ] **Step 3: Add `datasetId` param and WRITE check to `deleteMultiple`**

Change `deleteMultiple` to accept a `datasetId` query parameter and check WRITE access:

```python
@access.user
@describeRoute(
    Description("Delete all annotations in the id list")
    .param(
        "body",
        "A list of all annotation ids to delete.",
        paramType="body",
    )
    .param("datasetId", "The dataset ID", required=True)
)
@memoizeBodyJson
@recordable(
    "Delete multiple annotations",
    getDatasetIdFromAnnotationIdListInBody,
)
def deleteMultiple(self, params, *args, **kwargs):
    datasetId = ObjectId(params["datasetId"])
    Folder().load(
        datasetId,
        user=self.getCurrentUser(),
        level=AccessType.WRITE,
        exc=True,
    )
    bodyJson = kwargs["memoizedBodyJson"]
    stringIds = [stringId for stringId in bodyJson]
    self._annotationModel.deleteMultiple(stringIds)
```

- [ ] **Step 4: Run tests**

```bash
cd devops/girder/plugins/AnnotationPlugin && tox
```

Expected: `TestAnnotationAccessControl` tests now PASS.

---

## Task 3: Fix Connection Endpoints

**Files:**
- Modify: `devops/girder/plugins/AnnotationPlugin/upenncontrast_annotation/server/api/connections.py`

- [ ] **Step 1: Add dataset WRITE check to `create`**

```python
def create(self, params, *args, **kwargs):
    bodyJson = kwargs["memoizedBodyJson"]
    connection = self._connectionModel.convertIdsToObjectIds(bodyJson)
    Folder().load(
        connection["datasetId"],
        user=self.getCurrentUser(),
        level=AccessType.WRITE,
        exc=True,
    )
    return self._connectionModel.create(connection)
```

- [ ] **Step 2: Add dataset WRITE check to `multipleCreate`**

```python
def multipleCreate(self, params, *args, **kwargs):
    bodyJson = kwargs["memoizedBodyJson"]
    connections = self._connectionModel.convertIdsToObjectIds(bodyJson)
    if connections:
        Folder().load(
            connections[0]["datasetId"],
            user=self.getCurrentUser(),
            level=AccessType.WRITE,
            exc=True,
        )
    return self._connectionModel.createMultiple(connections)
```

- [ ] **Step 3: Add `datasetId` param and WRITE check to `deleteMultiple`**

```python
@access.user
@describeRoute(
    Description(
        "Delete all annotation connections in the id list"
    )
    .param(
        "body",
        "A list of all annotation connection ids to delete.",
        paramType="body",
    )
    .param("datasetId", "The dataset ID", required=True)
)
@memoizeBodyJson
@recordable(
    "Delete multiple connections",
    getDatasetIdFromConnectionIdListInBody,
)
def deleteMultiple(self, params, *args, **kwargs):
    datasetId = ObjectId(params["datasetId"])
    Folder().load(
        datasetId,
        user=self.getCurrentUser(),
        level=AccessType.WRITE,
        exc=True,
    )
    bodyJson = kwargs["memoizedBodyJson"]
    stringIds = [stringId for stringId in bodyJson]
    return self._connectionModel.deleteMultiple(stringIds)
```

- [ ] **Step 4: Make `datasetId` required on `find`**

Change `required=False` to `required=True` on line 185 of the `find` endpoint's `.param("datasetId", ...)`:

```python
.param(
    "datasetId", "Get all connections in this dataset", required=True
)
```

- [ ] **Step 5: Run tests**

```bash
cd devops/girder/plugins/AnnotationPlugin && tox
```

Expected: `TestConnectionAccessControl` tests now PASS.

---

## Task 4: Fix PropertyValues Endpoints

**Files:**
- Modify: `devops/girder/plugins/AnnotationPlugin/upenncontrast_annotation/server/api/propertyValues.py`

- [ ] **Step 1: Add dataset WRITE check to `add`**

```python
def add(self, params):
    params = self._annotationPropertyValuesModel.convertIdsToObjectIds(
        params)
    Folder().load(
        params["datasetId"],
        user=self.getCurrentUser(),
        level=AccessType.WRITE,
        exc=True,
    )
    return self._annotationPropertyValuesModel.appendValues(
        self.getBodyJson(),
        params["annotationId"],
        params["datasetId"],
    )
```

- [ ] **Step 2: Add dataset WRITE check to `addMultiple`**

Extract unique datasetIds from the body entries and check WRITE on each:

```python
def addMultiple(self, params):
    propertyValuesList = self._annotationPropertyValuesModel.\
        convertIdsToObjectIds(self.getBodyJson())
    datasetIds = {
        entry["datasetId"]
        for entry in propertyValuesList
        if "datasetId" in entry
    }
    user = self.getCurrentUser()
    for datasetId in datasetIds:
        Folder().load(
            datasetId,
            user=user,
            level=AccessType.WRITE,
            exc=True,
        )
    return self._annotationPropertyValuesModel.appendMultipleValues(
        propertyValuesList
    )
```

- [ ] **Step 3: Add dataset WRITE check to `delete`**

```python
def delete(self, params):
    if "propertyId" not in params:
        raise RestException(
            code=400, message="Property ID was invalid"
        )
    if "datasetId" not in params:
        raise RestException(
            code=400, message="Dataset ID was invalid"
        )
    params = self._annotationPropertyValuesModel.convertIdsToObjectIds(
        params)
    Folder().load(
        params["datasetId"],
        user=self.getCurrentUser(),
        level=AccessType.WRITE,
        exc=True,
    )
    self._annotationPropertyValuesModel.delete(
        params["propertyId"], params["datasetId"]
    )
```

- [ ] **Step 4: Add dataset READ check to `histogram`**

```python
def histogram(self, params):
    params = self._annotationPropertyValuesModel.convertIdsToObjectIds(
        params)
    Folder().load(
        params["datasetId"],
        user=self.getCurrentUser(),
        level=AccessType.READ,
        exc=True,
    )
    if "buckets" in params:
        return self._annotationPropertyValuesModel.histogram(
            params["propertyPath"],
            params["datasetId"],
            int(params["buckets"]),
        )
    else:
        return self._annotationPropertyValuesModel.histogram(
            params["propertyPath"], params["datasetId"]
        )
```

- [ ] **Step 5: Run tests**

```bash
cd devops/girder/plugins/AnnotationPlugin && tox
```

Expected: `TestPropertyValuesAccessControl` tests now PASS.

---

## Task 5: Fix Export Endpoint

**Files:**
- Modify: `devops/girder/plugins/AnnotationPlugin/upenncontrast_annotation/server/api/export.py`

- [ ] **Step 1: Replace `force=True` with user-level access check in `_getProperties`**

Change `_getProperties` to accept `user` parameter and use it for access checks:

```python
def _getProperties(self, datasetId, configurationId, user):
    propertyIds = set()

    if configurationId:
        config = self._collectionModel.load(
            configurationId,
            user=user,
            level=AccessType.READ,
            exc=True,
        )
        if 'meta' in config and 'propertyIds' in config['meta']:
            for pid in config['meta']['propertyIds']:
                propertyIds.add(ObjectId(pid))
    else:
        datasetViews = list(
            self._datasetViewModel.collection.find({
                'datasetId': datasetId
            })
        )
        configIds = {dv['configurationId'] for dv in datasetViews}

        for configId in configIds:
            config = self._collectionModel.load(
                configId, user=user, level=AccessType.READ
            )
            if (config and 'meta' in config
                    and 'propertyIds' in config['meta']):
                for pid in config['meta']['propertyIds']:
                    propertyIds.add(ObjectId(pid))

    if propertyIds:
        return list(self._propertyModel.find(
            {"_id": {"$in": list(propertyIds)}}
        ))
    return []
```

- [ ] **Step 2: Update the caller in `exportJson`**

Change line 170-172 to pass user:

```python
if includeProperties:
    data["annotationProperties"] = self._getProperties(
        datasetObjectId, configObjectId, self.getCurrentUser()
    )
```

- [ ] **Step 3: Run tests**

```bash
cd devops/girder/plugins/AnnotationPlugin && tox
```

Expected: `TestExportAccessControl` tests now PASS.

---

## Task 6: Fix History Endpoints

**Files:**
- Modify: `devops/girder/plugins/AnnotationPlugin/upenncontrast_annotation/server/api/history.py`

- [ ] **Step 1: Add Folder import and dataset access checks**

Add `from girder.models.folder import Folder` and `from girder.constants import AccessType` to imports.

Add dataset READ check to `find`, WRITE check to `undo` and `redo`:

```python
def find(self, params):
    user = self.getCurrentUser()
    if user is None:
        raise AccessException("You must be logged in.")
    if "datasetId" not in params:
        raise RestException(
            code=400, message="Dataset ID is missing"
        )
    datasetId = ObjectId(params["datasetId"])
    Folder().load(
        datasetId, user=user, level=AccessType.READ, exc=True
    )
    return self._historyModel.getLastEntries(user, datasetId)

def undo(self, params):
    user = self.getCurrentUser()
    if user is None:
        raise AccessException("You must be logged in.")
    if "datasetId" not in params:
        raise RestException(
            code=400, message="Dataset ID is missing"
        )
    datasetId = ObjectId(params["datasetId"])
    Folder().load(
        datasetId, user=user, level=AccessType.WRITE, exc=True
    )
    return self._historyModel.undo(user, datasetId)

def redo(self, params):
    user = self.getCurrentUser()
    if user is None:
        raise AccessException("You must be logged in.")
    if "datasetId" not in params:
        raise RestException(
            code=400, message="Dataset ID is missing"
        )
    datasetId = ObjectId(params["datasetId"])
    Folder().load(
        datasetId, user=user, level=AccessType.WRITE, exc=True
    )
    self._historyModel.redo(user, datasetId)
```

- [ ] **Step 2: Run tests**

```bash
cd devops/girder/plugins/AnnotationPlugin && tox
```

Expected: `TestHistoryAccessControl` tests now PASS.

---

## Task 7: Fix Worker and Assetstore Endpoints

**Files:**
- Modify: `devops/girder/plugins/AnnotationPlugin/upenncontrast_annotation/server/api/workerInterfaces.py`
- Modify: `devops/girder/plugins/AnnotationPlugin/upenncontrast_annotation/server/api/workerPreviews.py`
- Modify: `devops/girder/plugins/AnnotationPlugin/upenncontrast_annotation/server/api/user_assetstore.py`

- [ ] **Step 1: Change `workerInterfaces.update` to `@access.admin`**

In `workerInterfaces.py`, change `@access.user` on the `update` method (line 43) to `@access.admin`.

- [ ] **Step 2: Change `workerPreviews.update` and `clearImagePreview` to `@access.admin`**

In `workerPreviews.py`:
- Change `@access.user` on `clearImagePreview` (line 25) to `@access.admin`
- Change `@access.user` on `update` (line 42) to `@access.admin`

- [ ] **Step 3: Change `user_assetstore.find` to `@access.admin`**

In `user_assetstore.py`, change `@access.user` on the `find` method (line 21) to `@access.admin`.

- [ ] **Step 4: Run tests**

```bash
cd devops/girder/plugins/AnnotationPlugin && tox
```

Expected: All `TestWorkerInterfacesAccessControl`, `TestWorkerPreviewsAccessControl`, and `TestUserAssetstoreAccessControl` tests now PASS.

---

## Task 8: Update Frontend to Pass datasetId to Bulk Deletes

**Files:**
- Modify: `src/store/AnnotationsAPI.ts`
- Modify: `src/store/annotation.ts`
- Modify: `src/utils/annotationImport.ts`

- [ ] **Step 1: Update `AnnotationsAPI.ts` methods**

Change `deleteMultipleAnnotations` to accept and pass `datasetId`:

```typescript
async deleteMultipleAnnotations(annotationIds: string[], datasetId: string) {
    return this.client.delete("upenn_annotation/multiple", {
      data: annotationIds,
      params: { datasetId },
    });
  }
```

Change `deleteMultipleConnections` similarly:

```typescript
deleteMultipleConnections(connectionIds: string[], datasetId: string) {
    return this.client.delete("annotation_connection/multiple", {
      data: connectionIds,
      params: { datasetId },
    });
  }
```

- [ ] **Step 2: Update callers in `annotation.ts`**

Update `deleteConnections` (around line 601):
```typescript
await this.annotationsAPI.deleteMultipleConnections(connectionIds, main.dataset!.id);
```

Update `deleteAnnotations` (around line 824):
```typescript
await this.annotationsAPI.deleteMultipleAnnotations(ids, main.dataset!.id);
```

Update the import handling connection delete (around line 1146):
```typescript
await this.annotationsAPI.deleteMultipleConnections(
    connectionIdsToDelete,
    main.dataset!.id,
);
```

- [ ] **Step 3: Update caller in `annotationImport.ts`**

Update the call at line 252:
```typescript
store.annotationsAPI.deleteMultipleAnnotations(annotationIdsToRemove, store.dataset!.id),
```

- [ ] **Step 4: Run frontend type check**

```bash
pnpm tsc
```

Expected: No new type errors.

---

## Task 9: Full Integration Test

- [ ] **Step 1: Run all backend tests**

```bash
cd devops/girder/plugins/AnnotationPlugin && tox
```

Expected: ALL tests pass (both new security tests and existing tests).

- [ ] **Step 2: Run frontend lint and type check**

```bash
pnpm tsc && pnpm lint:ci
```

Expected: No errors.

- [ ] **Step 3: Rebuild and restart Docker**

```bash
docker compose build && docker compose up -d
```

- [ ] **Step 4: Commit all changes**

```bash
git add -A && git commit -m "security: add access control checks to all backend endpoints

- Add dataset WRITE checks to annotation/connection create and bulk delete
- Add datasetId parameter to bulk delete endpoints
- Add dataset WRITE checks to propertyValues add/addMultiple/delete
- Add dataset READ check to propertyValues histogram
- Fix export.py force=True bypass with user-level access check
- Add dataset access checks to history undo/redo
- Restrict worker interface/preview write endpoints to admin
- Restrict assetstore listing to admin
- Add comprehensive access control test suite
- Update frontend to pass datasetId to bulk delete endpoints"
```

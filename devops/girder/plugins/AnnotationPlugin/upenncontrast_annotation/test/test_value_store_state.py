"""Tests for the columnar-store state machine and read-routing conditions.

The state machine is what keeps a half-built or stale Zarr store from ever
being served, so each transition and each guard is pinned here. These need
Girder (folder metadata), so they run under tox, not standalone.
"""

import pytest

from girder.models.folder import Folder

from upenncontrast_annotation.server.helpers import valueStoreState as state
from upenncontrast_annotation.server.models.annotation import (
    Annotation as AnnotationModel,
)

from . import girder_utilities as utilities
from . import upenn_testing_utilities as upenn_utilities


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestValueStoreState:
    def _dataset(self, admin, name="ds"):
        return utilities.createFolder(
            admin, name, upenn_utilities.datasetMetadata
        )

    def testNoStateByDefault(self, admin):
        dataset = self._dataset(admin)
        assert state.get_state(dataset) is None
        assert state.is_zarr_ready(dataset) is False
        assert state.get_generation(dataset) == 0
        # A dataset with no store must never route to Zarr.
        assert state.should_serve_from_zarr(dataset) is False

    def testBuildingIsNotServed(self, admin):
        # The whole point of the "building" state: reads keep using MongoDB
        # while a build is in flight, so a partial store is never served.
        dataset = self._dataset(admin)
        state.mark_building(dataset)
        dataset = Folder().load(dataset["_id"], force=True)
        assert state.get_state(dataset)["status"] == state.STATUS_BUILDING
        assert state.is_zarr_ready(dataset) is False
        assert state.should_serve_from_zarr(dataset) is False

    def testReadyRecordsGenerationAndShape(self, admin):
        dataset = self._dataset(admin)
        state.mark_building(dataset)
        dataset = Folder().load(dataset["_id"], force=True)
        state.mark_ready(dataset, generation=3, rows=10, columns=4)
        dataset = Folder().load(dataset["_id"], force=True)

        stored = state.get_state(dataset)
        assert stored["status"] == state.STATUS_READY
        assert stored["generation"] == 3
        assert stored["rows"] == 10
        assert stored["columns"] == 4
        assert state.is_zarr_ready(dataset) is True
        assert state.get_generation(dataset) == 3

    def testDirtyStopsBeingServed(self, admin):
        dataset = self._dataset(admin)
        state.mark_ready(dataset, generation=1, rows=1, columns=1)
        dataset = Folder().load(dataset["_id"], force=True)
        assert state.is_zarr_ready(dataset) is True

        state.mark_dirty(dataset)
        dataset = Folder().load(dataset["_id"], force=True)
        assert state.get_state(dataset)["status"] == state.STATUS_DIRTY
        assert state.is_zarr_ready(dataset) is False
        assert state.should_serve_from_zarr(dataset) is False
        # The generation is preserved, so the next build increments from it.
        assert state.get_generation(dataset) == 1

    def testDirtyIsANoOpWithoutAStore(self, admin):
        # Write paths call this unconditionally, so it must be free and
        # harmless for an ordinary dataset.
        dataset = self._dataset(admin)
        state.mark_dirty(dataset)
        dataset = Folder().load(dataset["_id"], force=True)
        assert state.get_state(dataset) is None

    def testClearStateReturnsToMongo(self, admin):
        dataset = self._dataset(admin)
        state.mark_ready(dataset, generation=1, rows=1, columns=1)
        dataset = Folder().load(dataset["_id"], force=True)

        state.clear_state(dataset)
        dataset = Folder().load(dataset["_id"], force=True)
        assert state.get_state(dataset) is None
        assert state.should_serve_from_zarr(dataset) is False

    def testMarkDatasetsDirtyOnlyTouchesStoreDatasets(self, admin):
        withStore = self._dataset(admin, "with-store")
        without = self._dataset(admin, "without-store")
        state.mark_ready(withStore, generation=1, rows=1, columns=1)

        state.mark_datasets_dirty([withStore["_id"], without["_id"]])

        withStore = Folder().load(withStore["_id"], force=True)
        without = Folder().load(without["_id"], force=True)
        assert state.get_state(withStore)["status"] == state.STATUS_DIRTY
        assert state.get_state(without) is None

    def testMarkDatasetsDirtyAcceptsStringIds(self, admin):
        # The API passes ids straight through from the request body, where they
        # may still be strings.
        dataset = self._dataset(admin)
        state.mark_ready(dataset, generation=1, rows=1, columns=1)

        state.mark_datasets_dirty([str(dataset["_id"])])

        dataset = Folder().load(dataset["_id"], force=True)
        assert state.get_state(dataset)["status"] == state.STATUS_DIRTY

    def testMarkDatasetsDirtyHandlesEmpty(self, admin):
        state.mark_datasets_dirty([])
        state.mark_datasets_dirty(set())


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestColumnarIdRouting:
    """`canServeIdsFromValuesAlone` decides whether /list/ids may be answered
    from the columnar store. It must be exactly as strict as the MongoDB
    PV-driven branch: property values carry no annotation fields, so any
    annotation-field filter has to fall back."""

    def testPropertyFilterOnlyCanUseValues(self):
        assert AnnotationModel().canServeIdsFromValuesAlone({
            "propertyFilters": [
                {"path": ["p"], "mode": "range", "min": 1},
            ],
        }) is True

    def testNoPropertyFilterCannot(self):
        # Nothing to answer from values; the annotation collection owns this.
        assert AnnotationModel().canServeIdsFromValuesAlone({}) is False
        assert AnnotationModel().canServeIdsFromValuesAlone({
            "propertyFilters": [],
        }) is False

    @pytest.mark.parametrize("extra", [
        {"shape": "point"},
        {"tags": {"values": ["nucleus"], "exclusive": False}},
        {"location": {"XY": 0}},
        {"idSubstring": "abc"},
        {"idConstraints": [["deadbeefdeadbeefdeadbeef"]]},
    ])
    def testAnnotationFieldFiltersForceMongo(self, extra):
        filters = {
            "propertyFilters": [
                {"path": ["p"], "mode": "range", "min": 1},
            ],
        }
        filters.update(extra)
        assert AnnotationModel().canServeIdsFromValuesAlone(filters) is False

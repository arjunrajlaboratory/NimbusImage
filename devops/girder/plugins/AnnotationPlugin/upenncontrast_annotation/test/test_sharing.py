"""Tests for dataset sharing functionality.

Tests the share, setDatasetPublic, and getDatasetAccess endpoints
in the DatasetView API.
"""
import pytest
import random

from girder.constants import AccessType
from girder.exceptions import AccessException
from girder.models.folder import Folder

from upenncontrast_annotation.server.models.datasetView import (
    DatasetView as DatasetViewModel
)
from upenncontrast_annotation.server.models.collection import Collection

from . import girder_utilities as utilities
from . import upenn_testing_utilities as upenn_utilities


def createDatasetWithView(creator):
    """Create a dataset folder, configuration, and dataset view."""
    # Create dataset folder with unique name
    unique_name = f"test_dataset_{random.random()}"
    dataset = utilities.createFolder(
        creator, unique_name, upenn_utilities.datasetMetadata
    )

    # Create configuration with unique name
    config_meta = {
        "subtype": "contrastDataset",
        "compatibility": {},
        "layers": [],
        "tools": [],
        "propertyIds": [],
        "snapshots": [],
        "scales": {}
    }
    config_name = f"test_config_{random.random()}"
    config = Collection().createCollection(
        name=config_name,
        creator=creator,
        folder=dataset,
        metadata=config_meta,
        description="Test configuration"
    )

    # Create dataset view linking them
    datasetView = DatasetViewModel().create(
        creator,
        {
            "datasetId": dataset["_id"],
            "configurationId": config["_id"],
            "lastLocation": {"xy": 0, "z": 0, "time": 0},
            "layerContrasts": {}
        }
    )

    return dataset, config, datasetView


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestSharing:
    """Tests for the share endpoint."""

    def testShareWithReadAccess(self, admin, user):
        """Test sharing a dataset view with READ access."""
        dataset, config, datasetView = createDatasetWithView(admin)

        # Share with user at READ level
        DatasetViewModel().setUserAccess(
            datasetView, user, AccessType.READ, save=True
        )
        Collection().setUserAccess(
            config, user, AccessType.READ, save=True
        )
        Folder().setUserAccess(
            dataset, user, AccessType.READ, save=True
        )

        # User should now be able to load the dataset view
        loaded = DatasetViewModel().load(
            datasetView["_id"], user=user, level=AccessType.READ
        )
        assert loaded is not None
        assert loaded["_id"] == datasetView["_id"]

        # But user should NOT have write access (raises AccessException)
        with pytest.raises(AccessException):
            DatasetViewModel().load(
                datasetView["_id"], user=user, level=AccessType.WRITE
            )

    def testShareWithWriteAccess(self, admin, user):
        """Test sharing a dataset view with WRITE access."""
        dataset, config, datasetView = createDatasetWithView(admin)

        # Share with user at WRITE level
        DatasetViewModel().setUserAccess(
            datasetView, user, AccessType.WRITE, save=True
        )
        Collection().setUserAccess(
            config, user, AccessType.WRITE, save=True
        )
        Folder().setUserAccess(
            dataset, user, AccessType.WRITE, save=True
        )

        # User should have write access
        loaded = DatasetViewModel().load(
            datasetView["_id"], user=user, level=AccessType.WRITE
        )
        assert loaded is not None
        assert loaded["_id"] == datasetView["_id"]

    def testRemoveAccess(self, admin, user):
        """Test removing access using -1 (Girder convention)."""
        dataset, config, datasetView = createDatasetWithView(admin)

        # First grant access
        DatasetViewModel().setUserAccess(
            datasetView, user, AccessType.READ, save=True
        )
        Folder().setUserAccess(
            dataset, user, AccessType.READ, save=True
        )

        # Verify user has access
        loaded = DatasetViewModel().load(
            datasetView["_id"], user=user, level=AccessType.READ
        )
        assert loaded is not None

        # Remove access using -1
        DatasetViewModel().setUserAccess(
            datasetView, user, -1, save=True
        )
        Folder().setUserAccess(
            dataset, user, -1, save=True
        )

        # User should no longer have access (raises AccessException)
        with pytest.raises(AccessException):
            DatasetViewModel().load(
                datasetView["_id"], user=user, level=AccessType.READ
            )

    def testAccessTypeValidation(self, admin):
        """Test that AccessType validates -1, 0, 1, 2 correctly."""
        # -1 should be valid (no access / remove)
        result = AccessType().validate(-1)
        assert result == -1

        # 0 should be valid (READ)
        result = AccessType().validate(0)
        assert result == AccessType.READ

        # 1 should be valid (WRITE)
        result = AccessType().validate(1)
        assert result == AccessType.WRITE

        # 2 should be valid (ADMIN)
        result = AccessType().validate(2)
        assert result == AccessType.ADMIN

        # Invalid values should raise
        with pytest.raises(Exception):
            AccessType().validate(99)


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestSetDatasetPublic:
    """Tests for the setDatasetPublic endpoint."""

    def testMakeDatasetPublic(self, admin):
        """Test making a dataset and its resources public."""
        dataset, config, datasetView = createDatasetWithView(admin)

        # First ensure they are private
        Folder().setPublic(dataset, False, save=True)
        DatasetViewModel().setPublic(datasetView, False, save=True)
        Collection().setPublic(config, False, save=True)

        # Reload and verify private
        dataset = Folder().load(dataset["_id"], force=True)
        assert dataset.get("public", False) is False

        # Now make public
        Folder().setPublic(dataset, True, save=True)
        DatasetViewModel().setPublic(datasetView, True, save=True)
        Collection().setPublic(config, True, save=True)

        # Reload and verify public
        dataset = Folder().load(dataset["_id"], force=True)
        datasetView = DatasetViewModel().load(datasetView["_id"], force=True)
        config = Collection().load(config["_id"], force=True)

        assert dataset.get("public", False) is True
        assert datasetView.get("public", False) is True
        assert config.get("public", False) is True

    def testMakeDatasetPrivate(self, admin):
        """Test making a public dataset private."""
        dataset, config, datasetView = createDatasetWithView(admin)

        # Make public first
        Folder().setPublic(dataset, True, save=True)
        DatasetViewModel().setPublic(datasetView, True, save=True)
        Collection().setPublic(config, True, save=True)

        # Now make private
        Folder().setPublic(dataset, False, save=True)
        DatasetViewModel().setPublic(datasetView, False, save=True)
        Collection().setPublic(config, False, save=True)

        # Reload and verify
        dataset = Folder().load(dataset["_id"], force=True)
        datasetView = DatasetViewModel().load(datasetView["_id"], force=True)
        config = Collection().load(config["_id"], force=True)

        assert dataset.get("public", False) is False
        assert datasetView.get("public", False) is False
        assert config.get("public", False) is False

    def testPublicDatasetAccessibleToAnonymous(self, admin):
        """Test that public datasets are accessible without authentication."""
        dataset, config, datasetView = createDatasetWithView(admin)

        # Make public
        Folder().setPublic(dataset, True, save=True)
        DatasetViewModel().setPublic(datasetView, True, save=True)

        # Should be accessible with user=None (anonymous)
        loaded = DatasetViewModel().load(
            datasetView["_id"], user=None, level=AccessType.READ
        )
        assert loaded is not None
        assert loaded["_id"] == datasetView["_id"]


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestGetDatasetAccess:
    """Tests for the getDatasetAccess endpoint."""

    def testGetAccessListBasic(self, admin):
        """Test getting the access list for a dataset."""
        dataset, config, datasetView = createDatasetWithView(admin)

        # Get access list
        accessList = Folder().getFullAccessList(dataset)

        # Should have users and groups
        assert "users" in accessList
        assert "groups" in accessList

        # Admin should be in the users list
        adminInList = any(
            u["id"] == admin["_id"] for u in accessList["users"]
        )
        assert adminInList is True

    def testGetAccessListWithSharedUser(self, admin, user):
        """Test that shared users appear in access list."""
        dataset, config, datasetView = createDatasetWithView(admin)

        # Share with user
        Folder().setUserAccess(dataset, user, AccessType.READ, save=True)

        # Get access list
        accessList = Folder().getFullAccessList(dataset)

        # Both admin and user should be in the list
        userIds = {u["id"] for u in accessList["users"]}
        assert admin["_id"] in userIds
        assert user["_id"] in userIds

    def testAccessListShowsCorrectLevels(self, admin, user):
        """Test that access levels are correctly reported."""
        dataset, config, datasetView = createDatasetWithView(admin)

        # Share with user at READ level
        Folder().setUserAccess(dataset, user, AccessType.READ, save=True)

        # Get access list
        accessList = Folder().getFullAccessList(dataset)

        # Find user in list and check level
        userEntry = next(
            (u for u in accessList["users"] if u["id"] == user["_id"]),
            None
        )
        assert userEntry is not None
        assert userEntry["level"] == AccessType.READ

        # Admin should have ADMIN level
        adminEntry = next(
            (u for u in accessList["users"] if u["id"] == admin["_id"]),
            None
        )
        assert adminEntry is not None
        assert adminEntry["level"] == AccessType.ADMIN


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestBulkFind:
    """Tests for bulk find operations using Model().find()."""

    def testFindMultipleDatasetViews(self, admin):
        """Test finding multiple dataset views in one query."""
        # Create multiple datasets with views
        dataset1, config1, view1 = createDatasetWithView(admin)
        dataset2, config2, view2 = createDatasetWithView(admin)
        dataset3, config3, view3 = createDatasetWithView(admin)

        # Bulk find by dataset IDs
        datasetIds = [dataset1["_id"], dataset2["_id"]]
        views = list(DatasetViewModel().find({
            "datasetId": {"$in": datasetIds}
        }))

        # Should find 2 views
        assert len(views) == 2
        viewDatasetIds = {v["datasetId"] for v in views}
        assert dataset1["_id"] in viewDatasetIds
        assert dataset2["_id"] in viewDatasetIds
        assert dataset3["_id"] not in viewDatasetIds

    def testFindWithPermissions(self, admin, user):
        """Test that findWithPermissions respects access control."""
        # Create dataset as admin
        dataset, config, datasetView = createDatasetWithView(admin)

        # User should NOT see it initially
        views = list(DatasetViewModel().findWithPermissions(
            {"datasetId": dataset["_id"]},
            user=user,
            level=AccessType.READ
        ))
        assert len(views) == 0

        # Share with user
        DatasetViewModel().setUserAccess(
            datasetView, user, AccessType.READ, save=True
        )

        # Now user should see it
        views = list(DatasetViewModel().findWithPermissions(
            {"datasetId": dataset["_id"]},
            user=user,
            level=AccessType.READ
        ))
        assert len(views) == 1
        assert views[0]["_id"] == datasetView["_id"]

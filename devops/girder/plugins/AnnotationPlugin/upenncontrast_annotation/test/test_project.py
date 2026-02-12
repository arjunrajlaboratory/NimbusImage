import pytest
import random

from upenncontrast_annotation.server.models.project import Project
from upenncontrast_annotation.server.models import project
from upenncontrast_annotation.server.models.collection import Collection
from upenncontrast_annotation.server.models.datasetView import (
    DatasetView as DatasetViewModel
)

from girder.constants import AccessType
from girder.exceptions import ValidationException, AccessException
from girder.models.folder import Folder

from . import girder_utilities as utilities
from . import upenn_testing_utilities as upenn_utilities


def get_sample_project(name="Test Project", description="Test description"):
    """Create a sample project dict for testing."""
    return {
        "name": name,
        "description": description,
    }


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestProject:
    def test_project_schema(self):
        """Test that project schema is properly defined."""
        schema = project.ProjectSchema
        assert schema.projectSchema is not None
        assert "name" in schema.projectSchema["properties"]
        assert "description" in schema.projectSchema["properties"]
        assert "meta" in schema.projectSchema["properties"]

    def test_project_create(self, admin):
        """Test creating a new project."""
        project_model = Project()
        result = project_model.createProject(
            name="Test Project",
            creator=admin,
            description="A test project"
        )

        assert "_id" in result
        assert result["name"] == "Test Project"
        assert result["description"] == "A test project"
        assert result["creatorId"] == admin["_id"]
        assert result["meta"]["status"] == "draft"
        assert result["meta"]["datasets"] == []
        assert result["meta"]["collections"] == []

    def test_project_load(self, admin):
        """Test loading a project by ID."""
        project_model = Project()

        # Test loading invalid ID
        with pytest.raises(Exception, match="Invalid ObjectId"):
            project_model.load("nosuchid", user=admin)

        # Test loading non-existent ID
        assert (
            project_model.load("012345678901234567890123", user=admin) is None
        )

        # Create and load a project
        created = project_model.createProject(
            name="Load Test Project",
            creator=admin,
            description="Test"
        )

        loaded = project_model.load(created["_id"], user=admin)
        assert loaded is not None
        assert loaded["_id"] == created["_id"]
        assert loaded["name"] == "Load Test Project"

    def test_project_remove(self, admin):
        """Test removing a project."""
        project_model = Project()
        created = project_model.createProject(
            name="Remove Test Project",
            creator=admin,
            description="Test"
        )

        assert project_model.load(created["_id"], force=True) is not None
        project_model.remove(created)
        assert project_model.load(created["_id"], force=True) is None

    def test_project_add_dataset(self, admin):
        """Test adding a dataset to a project."""
        project_model = Project()

        # Create a dataset folder
        folder = utilities.createFolder(
            admin, "test_dataset", upenn_utilities.datasetMetadata
        )

        # Create a project
        proj = project_model.createProject(
            name="Dataset Test Project",
            creator=admin,
            description="Test"
        )

        # Add dataset to project
        updated = project_model.addDataset(proj, str(folder["_id"]))
        assert len(updated["meta"]["datasets"]) == 1
        # datasetId may be stored as ObjectId or string depending on
        # implementation
        assert (
            str(updated["meta"]["datasets"][0]["datasetId"])
            == str(folder["_id"])
        )

        # Adding same dataset again should raise ValidationException
        with pytest.raises(
            ValidationException, match="Dataset already in project"
        ):
            project_model.addDataset(updated, str(folder["_id"]))

    def test_project_remove_dataset(self, admin):
        """Test removing a dataset from a project."""
        project_model = Project()

        # Create a dataset folder
        folder = utilities.createFolder(
            admin, "test_dataset_remove", upenn_utilities.datasetMetadata
        )

        # Create a project with a dataset
        proj = project_model.createProject(
            name="Remove Dataset Test Project",
            creator=admin,
            description="Test"
        )
        proj = project_model.addDataset(proj, str(folder["_id"]))
        assert len(proj["meta"]["datasets"]) == 1

        # Remove the dataset
        updated = project_model.removeDataset(proj, str(folder["_id"]))
        assert len(updated["meta"]["datasets"]) == 0

    def test_project_update_fields(self, admin):
        """Test updating project name and description."""
        project_model = Project()

        proj = project_model.createProject(
            name="Original Name",
            creator=admin,
            description="Original description"
        )

        # Update name only
        updated = project_model.updateFields(proj, name="New Name")
        assert updated["name"] == "New Name"
        assert updated["description"] == "Original description"

        # Update description only
        updated = project_model.updateFields(
            updated, description="New description"
        )
        assert updated["name"] == "New Name"
        assert updated["description"] == "New description"

        # Update both
        updated = project_model.updateFields(
            updated, name="Final Name", description="Final description"
        )
        assert updated["name"] == "Final Name"
        assert updated["description"] == "Final description"

    def test_project_update_status(self, admin):
        """Test updating project status."""
        project_model = Project()

        proj = project_model.createProject(
            name="Status Test Project",
            creator=admin,
            description="Test"
        )
        assert proj["meta"]["status"] == "draft"

        # Update to exporting
        updated = project_model.updateStatus(proj, "exporting")
        assert updated["meta"]["status"] == "exporting"

        # Update to exported
        updated = project_model.updateStatus(updated, "exported")
        assert updated["meta"]["status"] == "exported"

    def test_project_update_metadata(self, admin):
        """Test updating project publication metadata."""
        project_model = Project()

        proj = project_model.createProject(
            name="Metadata Test Project",
            creator=admin,
            description="Test"
        )

        # Update metadata
        updated = project_model.updateMetadata(proj, {
            "title": "Publication Title",
            "description": "Publication description",
            "license": "MIT",
            "keywords": ["test", "project"]
        })

        assert updated["meta"]["metadata"]["title"] == "Publication Title"
        assert (
            updated["meta"]["metadata"]["description"]
            == "Publication description"
        )
        assert updated["meta"]["metadata"]["license"] == "MIT"
        assert updated["meta"]["metadata"]["keywords"] == ["test", "project"]

    def test_project_validate_empty(self, admin):
        """Test that empty project fails validation."""
        project_model = Project()
        empty = {}
        with pytest.raises(ValidationException):
            project_model.validate(empty)

    def test_project_find_with_permissions(self, admin, user):
        """Test finding projects with permission filtering."""
        project_model = Project()

        # Create projects as admin
        proj1 = project_model.createProject(
            name="Admin Project 1",
            creator=admin,
            description="Test"
        )
        proj2 = project_model.createProject(
            name="Admin Project 2",
            creator=admin,
            description="Test"
        )

        # Admin should see their projects
        admin_projects = list(
            project_model.findWithPermissions({}, user=admin)
        )
        assert len(admin_projects) >= 2
        # Verify the created projects are in the results
        project_ids = {p["_id"] for p in admin_projects}
        assert proj1["_id"] in project_ids
        assert proj2["_id"] in project_ids

        # Find by creatorId
        filtered = list(project_model.findWithPermissions(
            {"creatorId": admin["_id"]}, user=admin
        ))
        assert all(p["creatorId"] == admin["_id"] for p in filtered)

    def test_project_add_collection(self, admin):
        """Test adding a collection to a project."""
        project_model = Project()
        collection_model = Collection()

        # Create a dataset folder for the collection
        unique_name = f"test_dataset_coll_{random.random()}"
        folder = utilities.createFolder(
            admin, unique_name, upenn_utilities.datasetMetadata
        )

        # Create a collection (configuration)
        config_meta = {
            "subtype": "contrastDataset",
            "compatibility": {},
            "layers": [],
            "tools": [],
            "propertyIds": [],
            "snapshots": [],
            "scales": {}
        }
        config = collection_model.createCollection(
            name=f"test_config_{random.random()}",
            creator=admin,
            folder=folder,
            metadata=config_meta,
            description="Test configuration"
        )

        # Create a project
        proj = project_model.createProject(
            name="Collection Test Project",
            creator=admin,
            description="Test"
        )

        # Add collection to project
        updated = project_model.addCollection(proj, str(config["_id"]))
        assert len(updated["meta"]["collections"]) == 1
        assert (
            str(updated["meta"]["collections"][0]["collectionId"])
            == str(config["_id"])
        )

        # Adding same collection again should raise ValidationException
        with pytest.raises(
            ValidationException, match="Collection already in project"
        ):
            project_model.addCollection(updated, str(config["_id"]))

    def test_project_remove_collection(self, admin):
        """Test removing a collection from a project."""
        project_model = Project()
        collection_model = Collection()

        # Create a dataset folder for the collection
        unique_name = f"test_dataset_remove_coll_{random.random()}"
        folder = utilities.createFolder(
            admin, unique_name, upenn_utilities.datasetMetadata
        )

        # Create a collection
        config_meta = {
            "subtype": "contrastDataset",
            "compatibility": {},
            "layers": [],
            "tools": [],
            "propertyIds": [],
            "snapshots": [],
            "scales": {}
        }
        config = collection_model.createCollection(
            name=f"test_config_remove_{random.random()}",
            creator=admin,
            folder=folder,
            metadata=config_meta,
            description="Test configuration"
        )

        # Create a project with a collection
        proj = project_model.createProject(
            name="Remove Collection Test Project",
            creator=admin,
            description="Test"
        )
        proj = project_model.addCollection(proj, str(config["_id"]))
        assert len(proj["meta"]["collections"]) == 1

        # Remove the collection
        updated = project_model.removeCollection(proj, str(config["_id"]))
        assert len(updated["meta"]["collections"]) == 0

    def test_project_collection_access_control(self, admin, user):
        """Test that adding a collection requires WRITE access to it.

        This tests the access control at the model level. The API layer
        uses modelParam to enforce WRITE access on the collection before
        the model method is called.
        """
        collection_model = Collection()

        # Create a dataset folder for the collection as admin
        unique_name = f"test_dataset_access_{random.random()}"
        folder = utilities.createFolder(
            admin, unique_name, upenn_utilities.datasetMetadata
        )

        # Create a collection as admin
        config_meta = {
            "subtype": "contrastDataset",
            "compatibility": {},
            "layers": [],
            "tools": [],
            "propertyIds": [],
            "snapshots": [],
            "scales": {}
        }
        config = collection_model.createCollection(
            name=f"test_config_access_{random.random()}",
            creator=admin,
            folder=folder,
            metadata=config_meta,
            description="Test configuration"
        )

        # User should not have access to load the collection with WRITE level
        # (only the creator has access by default)
        with pytest.raises(AccessException):
            collection_model.load(
                config["_id"], user=user, level=AccessType.WRITE
            )

        # But user can load with READ if given READ access
        collection_model.setUserAccess(
            config, user, AccessType.READ, save=True
        )
        loaded = collection_model.load(
            config["_id"], user=user, level=AccessType.READ
        )
        assert loaded is not None

        # User still can't load with WRITE (only has READ)
        with pytest.raises(AccessException):
            collection_model.load(
                config["_id"], user=user, level=AccessType.WRITE
            )

        # Give user WRITE access
        collection_model.setUserAccess(
            config, user, AccessType.WRITE, save=True
        )

        # Now user can load with WRITE
        loaded = collection_model.load(
            config["_id"], user=user, level=AccessType.WRITE
        )
        assert loaded is not None


def createDatasetWithView(creator):
    """Create a dataset folder, configuration, and
    dataset view for testing.

    Uses a private parent folder so that only the creator
    has access by default.
    """
    unique_name = f"test_dataset_{random.random()}"
    dataset = utilities.createPrivateFolder(
        creator, unique_name,
        upenn_utilities.datasetMetadata
    )

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

    datasetView = DatasetViewModel().create(
        creator,
        {
            "datasetId": dataset["_id"],
            "configurationId": config["_id"],
            "lastLocation": {
                "xy": 0, "z": 0, "time": 0
            },
            "layerContrasts": {}
        }
    )

    return dataset, config, datasetView


@pytest.mark.usefixtures(
    "unbindLargeImage", "unbindAnnotation"
)
@pytest.mark.plugin("upenncontrast_annotation")
class TestProjectPermissionPropagation:

    def test_share_project_propagates_to_dataset(
        self, admin, user
    ):
        """Sharing a project gives the user access
        to all datasets in the project."""
        project_model = Project()

        dataset, config, dv = createDatasetWithView(
            admin
        )
        proj = project_model.createProject(
            name="Share Propagation Test",
            creator=admin
        )
        proj = project_model.addDataset(
            proj, str(dataset['_id'])
        )

        # User should not have access yet
        with pytest.raises(AccessException):
            Folder().load(
                dataset['_id'], user=user,
                level=AccessType.READ
            )

        # Share project with user at READ level
        project_model.setUserAccess(
            proj, user, AccessType.READ, save=True
        )
        project_model.propagateUserAccess(
            proj, user, AccessType.READ
        )

        # User should now have READ access to
        # dataset, config, and view
        assert Folder().load(
            dataset['_id'], user=user,
            level=AccessType.READ
        ) is not None
        assert Collection().load(
            config['_id'], user=user,
            level=AccessType.READ
        ) is not None
        assert DatasetViewModel().load(
            dv['_id'], user=user,
            level=AccessType.READ
        ) is not None

    def test_share_project_propagates_to_collection(
        self, admin, user
    ):
        """Sharing a project gives the user access
        to all collections in the project."""
        project_model = Project()

        dataset, config, dv = createDatasetWithView(
            admin
        )
        proj = project_model.createProject(
            name="Collection Share Test",
            creator=admin
        )
        proj = project_model.addCollection(
            proj, str(config['_id'])
        )

        # User should not have access yet
        with pytest.raises(AccessException):
            Collection().load(
                config['_id'], user=user,
                level=AccessType.READ
            )

        # Share project
        project_model.setUserAccess(
            proj, user, AccessType.READ, save=True
        )
        project_model.propagateUserAccess(
            proj, user, AccessType.READ
        )

        # User should now have READ access
        assert Collection().load(
            config['_id'], user=user,
            level=AccessType.READ
        ) is not None

    def test_revoke_project_access_revokes_resources(
        self, admin, user
    ):
        """Revoking project access removes user from
        all resources."""
        project_model = Project()

        dataset, config, dv = createDatasetWithView(
            admin
        )
        proj = project_model.createProject(
            name="Revoke Test", creator=admin
        )
        proj = project_model.addDataset(
            proj, str(dataset['_id'])
        )

        # Grant then revoke
        project_model.setUserAccess(
            proj, user, AccessType.READ, save=True
        )
        project_model.propagateUserAccess(
            proj, user, AccessType.READ
        )

        # Verify access was granted
        assert Folder().load(
            dataset['_id'], user=user,
            level=AccessType.READ
        ) is not None

        # Revoke (-1)
        project_model.setUserAccess(
            proj, user, -1, save=True
        )
        project_model.propagateUserAccess(
            proj, user, -1
        )

        # User should no longer have access
        with pytest.raises(AccessException):
            Folder().load(
                dataset['_id'], user=user,
                level=AccessType.READ
            )

    def test_add_dataset_syncs_existing_acl(
        self, admin, user
    ):
        """When a dataset is added to an already-shared
        project, the dataset gets the project's ACL."""
        project_model = Project()

        # Create project and share with user
        proj = project_model.createProject(
            name="Add Dataset Sync Test",
            creator=admin
        )
        project_model.setUserAccess(
            proj, user, AccessType.READ, save=True
        )

        # Create a dataset (user has no access)
        dataset, config, dv = createDatasetWithView(
            admin
        )
        with pytest.raises(AccessException):
            Folder().load(
                dataset['_id'], user=user,
                level=AccessType.READ
            )

        # Add dataset to project -- sync should happen
        proj = project_model.addDataset(
            proj, str(dataset['_id'])
        )
        project_model.propagateAccessToDataset(
            proj, dataset
        )

        # User should now have READ access
        assert Folder().load(
            dataset['_id'], user=user,
            level=AccessType.READ
        ) is not None

    def test_propagate_public(self, admin):
        """Making a project public makes all its
        resources public."""
        project_model = Project()

        dataset, config, dv = createDatasetWithView(
            admin
        )
        proj = project_model.createProject(
            name="Public Test", creator=admin
        )
        proj = project_model.addDataset(
            proj, str(dataset['_id'])
        )

        # Make public
        project_model.setPublic(
            proj, True, save=True
        )
        project_model.propagatePublic(proj, True)

        # Verify resources are public
        assert Folder().load(
            dataset['_id'], user=None,
            level=AccessType.READ
        ) is not None
        assert DatasetViewModel().load(
            dv['_id'], user=None,
            level=AccessType.READ
        ) is not None

        # Make private
        project_model.setPublic(
            proj, False, save=True
        )
        project_model.propagatePublic(proj, False)

        # Verify resources are no longer public
        with pytest.raises(AccessException):
            Folder().load(
                dataset['_id'], user=None,
                level=AccessType.READ
            )

    def test_add_dataset_to_public_project(
        self, admin
    ):
        """Adding a dataset to a public project makes
        the dataset and its views/configs public."""
        project_model = Project()

        # Create a public project
        proj = project_model.createProject(
            name="Add DS to Public", creator=admin
        )
        project_model.setPublic(
            proj, True, save=True
        )

        # Create a private dataset with view
        dataset, config, dv = createDatasetWithView(
            admin
        )

        # Dataset should not be publicly accessible
        with pytest.raises(AccessException):
            Folder().load(
                dataset['_id'], user=None,
                level=AccessType.READ
            )

        # Add dataset to the public project
        proj = project_model.addDataset(
            proj, str(dataset['_id'])
        )
        project_model.propagatePublicToDataset(
            proj, dataset
        )

        # Dataset, view, and config should now be public
        assert Folder().load(
            dataset['_id'], user=None,
            level=AccessType.READ
        ) is not None
        assert DatasetViewModel().load(
            dv['_id'], user=None,
            level=AccessType.READ
        ) is not None
        assert Collection().load(
            config['_id'], user=None,
            level=AccessType.READ
        ) is not None

    def test_add_collection_to_public_project(
        self, admin
    ):
        """Adding a collection to a public project makes
        the collection and its views/datasets public."""
        project_model = Project()

        # Create a public project
        proj = project_model.createProject(
            name="Add Coll to Public", creator=admin
        )
        project_model.setPublic(
            proj, True, save=True
        )

        # Create a private dataset with view
        dataset, config, dv = createDatasetWithView(
            admin
        )

        # Collection should not be publicly accessible
        with pytest.raises(AccessException):
            Collection().load(
                config['_id'], user=None,
                level=AccessType.READ
            )

        # Add collection to the public project
        proj = project_model.addCollection(
            proj, str(config['_id'])
        )
        project_model.propagatePublicToCollection(
            proj, config
        )

        # Collection, view, and dataset should be public
        assert Collection().load(
            config['_id'], user=None,
            level=AccessType.READ
        ) is not None
        assert DatasetViewModel().load(
            dv['_id'], user=None,
            level=AccessType.READ
        ) is not None
        assert Folder().load(
            dataset['_id'], user=None,
            level=AccessType.READ
        ) is not None

    def test_add_dataset_to_private_project_no_op(
        self, admin
    ):
        """Adding a dataset to a private project does
        not change its public flag."""
        project_model = Project()

        proj = project_model.createProject(
            name="Add DS to Private", creator=admin
        )

        dataset, config, dv = createDatasetWithView(
            admin
        )

        proj = project_model.addDataset(
            proj, str(dataset['_id'])
        )
        project_model.propagatePublicToDataset(
            proj, dataset
        )

        # Dataset should still not be public
        with pytest.raises(AccessException):
            Folder().load(
                dataset['_id'], user=None,
                level=AccessType.READ
            )

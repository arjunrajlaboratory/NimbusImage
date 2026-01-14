import pytest

from upenncontrast_annotation.server.models.project import Project
from upenncontrast_annotation.server.models import project

from girder.exceptions import ValidationException

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

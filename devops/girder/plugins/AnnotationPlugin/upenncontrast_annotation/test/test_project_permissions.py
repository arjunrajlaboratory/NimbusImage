"""
Tests for project-based permission masking.

Tests the permission masking behavior where:
- Direct resource access uses only resource ACL
- Project-scoped access requires BOTH project AND resource permissions
- The most restrictive permission wins when accessing through a project
"""
import pytest
import random

from bson import ObjectId
from girder.constants import AccessType
from girder.exceptions import AccessException
from girder.models.folder import Folder

from upenncontrast_annotation.server.models.project import Project
from upenncontrast_annotation.server.helpers.projectContext import (
    set_project_context,
    get_project_context,
    clear_project_context,
    check_project_access_for_resource,
)

from . import girder_utilities as utilities
from . import upenn_testing_utilities as upenn_utilities


def create_dataset(user, name=None):
    """Helper to create a dataset folder."""
    name = name or f"dataset_{random.random()}"
    return utilities.createFolder(user, name, upenn_utilities.datasetMetadata)


def create_project_with_dataset(user, dataset, name=None):
    """Helper to create a project with a dataset."""
    project_model = Project()
    name = name or f"project_{random.random()}"
    project = project_model.createProject(
        name=name,
        creator=user,
        description="Test project"
    )
    return project_model.addDataset(project, dataset['_id'])


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestProjectContext:
    """Tests for project context management."""

    def test_set_and_get_context(self):
        """Test basic context set/get/clear operations."""
        clear_project_context()
        assert get_project_context() is None

        project_id = str(ObjectId())
        set_project_context(project_id)
        assert get_project_context() == project_id

        clear_project_context()
        assert get_project_context() is None

    def test_set_none_clears_context(self):
        """Test that setting None clears the context."""
        project_id = str(ObjectId())
        set_project_context(project_id)
        assert get_project_context() == project_id

        set_project_context(None)
        assert get_project_context() is None


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestProjectPermissionMasking:
    """Tests for the permission masking behavior."""

    def test_no_context_allows_direct_access(self, admin, user):
        """
        Test that without project context, direct dataset access works.
        """
        dataset = create_dataset(admin)
        Folder().setUserAccess(dataset, user, AccessType.READ, save=True)

        clear_project_context()
        # Should not raise any exception
        check_project_access_for_resource(
            user, dataset['_id'], 'dataset', AccessType.READ
        )

    def test_project_context_requires_project_access(self, admin, user):
        """
        Test that project context requires user to have project access.

        Even if user has dataset access, accessing through project context
        should fail without project access.
        """
        dataset = create_dataset(admin)
        Folder().setUserAccess(dataset, user, AccessType.READ, save=True)

        project = create_project_with_dataset(admin, dataset)
        # Note: project is created by admin, user has no access

        # Without project context, access works
        clear_project_context()
        check_project_access_for_resource(
            user, dataset['_id'], 'dataset', AccessType.READ
        )

        # With project context, access should fail (no project permissions)
        set_project_context(str(project['_id']))
        try:
            with pytest.raises(AccessException, match='insufficient project'):
                check_project_access_for_resource(
                    user, dataset['_id'], 'dataset', AccessType.READ
                )
        finally:
            clear_project_context()

    def test_project_context_with_both_permissions(self, admin, user):
        """
        Test that project-scoped access works when user has both permissions.
        """
        dataset = create_dataset(admin)
        Folder().setUserAccess(dataset, user, AccessType.READ, save=True)

        project = create_project_with_dataset(admin, dataset)
        project_model = Project()
        project_model.setUserAccess(project, user, AccessType.READ, save=True)

        # With project context, access should work
        set_project_context(str(project['_id']))
        try:
            check_project_access_for_resource(
                user, dataset['_id'], 'dataset', AccessType.READ
            )
        finally:
            clear_project_context()

    def test_dataset_not_in_project_blocked(self, admin, user):
        """
        Test that accessing a dataset NOT in the project fails.
        """
        dataset = create_dataset(admin)
        Folder().setUserAccess(dataset, user, AccessType.READ, save=True)

        # Create a project WITHOUT the dataset
        project_model = Project()
        project = project_model.createProject(
            name=f"empty_project_{random.random()}",
            creator=admin,
            description="Test"
        )
        project_model.setUserAccess(project, user, AccessType.READ, save=True)

        set_project_context(str(project['_id']))
        try:
            with pytest.raises(AccessException, match='not part of project'):
                check_project_access_for_resource(
                    user, dataset['_id'], 'dataset', AccessType.READ
                )
        finally:
            clear_project_context()

    def test_write_requires_write_on_both(self, admin, user):
        """
        Test that WRITE operations require WRITE on both project and resource.
        """
        dataset = create_dataset(admin)
        Folder().setUserAccess(dataset, user, AccessType.WRITE, save=True)

        project = create_project_with_dataset(admin, dataset)
        project_model = Project()
        # Give only READ on project
        project_model.setUserAccess(project, user, AccessType.READ, save=True)

        set_project_context(str(project['_id']))
        try:
            # READ should work
            check_project_access_for_resource(
                user, dataset['_id'], 'dataset', AccessType.READ
            )

            # WRITE should fail (only READ on project)
            with pytest.raises(AccessException):
                check_project_access_for_resource(
                    user, dataset['_id'], 'dataset', AccessType.WRITE
                )
        finally:
            clear_project_context()

    def test_admin_access_requires_admin_on_both(self, admin, user):
        """
        Test that ADMIN operations require ADMIN on both project and resource.
        """
        dataset = create_dataset(admin)
        Folder().setUserAccess(dataset, user, AccessType.ADMIN, save=True)

        project = create_project_with_dataset(admin, dataset)
        project_model = Project()
        # Give only WRITE on project
        project_model.setUserAccess(project, user, AccessType.WRITE, save=True)

        set_project_context(str(project['_id']))
        try:
            # WRITE should work
            check_project_access_for_resource(
                user, dataset['_id'], 'dataset', AccessType.WRITE
            )

            # ADMIN should fail (only WRITE on project)
            with pytest.raises(AccessException):
                check_project_access_for_resource(
                    user, dataset['_id'], 'dataset', AccessType.ADMIN
                )
        finally:
            clear_project_context()


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestProjectModelAccessHelpers:
    """Tests for Project model access helper methods."""

    def test_get_effective_access_level_owner(self, admin):
        """Test that project owner has ADMIN access."""
        project_model = Project()
        project = project_model.createProject(
            name=f"test_{random.random()}",
            creator=admin,
            description="Test"
        )

        level = project_model.getEffectiveAccessLevel(project, admin)
        assert level == AccessType.ADMIN

    def test_get_effective_access_level_no_access(self, admin, user):
        """Test that user without access returns None."""
        project_model = Project()
        project = project_model.createProject(
            name=f"test_{random.random()}",
            creator=admin,
            description="Test"
        )

        level = project_model.getEffectiveAccessLevel(project, user)
        assert level is None

    def test_get_effective_access_level_granted(self, admin, user):
        """Test access level for user with granted access."""
        project_model = Project()
        project = project_model.createProject(
            name=f"test_{random.random()}",
            creator=admin,
            description="Test"
        )
        project_model.setUserAccess(project, user, AccessType.WRITE, save=True)

        level = project_model.getEffectiveAccessLevel(project, user)
        assert level == AccessType.WRITE

    def test_get_effective_access_level_public(self, admin, user):
        """Test that public project gives READ to anonymous."""
        project_model = Project()
        project = project_model.createProject(
            name=f"test_{random.random()}",
            creator=admin,
            description="Test"
        )
        project_model.setPublic(project, True, save=True)

        level = project_model.getEffectiveAccessLevel(project, None)
        assert level == AccessType.READ

    def test_get_users_with_access(self, admin, user):
        """Test getting list of users with access."""
        project_model = Project()
        project = project_model.createProject(
            name=f"test_{random.random()}",
            creator=admin,
            description="Test"
        )
        project_model.setUserAccess(project, user, AccessType.READ, save=True)

        # Reload to get updated access
        project = project_model.load(project['_id'], force=True)

        users_read = project_model.getUsersWithAccess(project, AccessType.READ)
        assert admin['_id'] in users_read
        assert user['_id'] in users_read

        users_admin = project_model.getUsersWithAccess(
            project, AccessType.ADMIN
        )
        assert admin['_id'] in users_admin
        assert user['_id'] not in users_admin

    def test_find_projects_for_resource(self, admin):
        """Test finding projects containing a resource."""
        project_model = Project()
        dataset = create_dataset(admin)

        # Create two projects, one with dataset
        project1 = create_project_with_dataset(admin, dataset, "project1")
        project2 = project_model.createProject(
            name="project2",
            creator=admin,
            description="No dataset"
        )

        projects = list(project_model.findProjectsForResource(
            dataset['_id'], 'dataset', user=admin
        ))

        project_ids = [p['_id'] for p in projects]
        assert project1['_id'] in project_ids
        assert project2['_id'] not in project_ids

    def test_has_resource_access(self, admin, user):
        """Test hasResourceAccess method."""
        project_model = Project()
        dataset = create_dataset(admin)
        Folder().setUserAccess(dataset, user, AccessType.READ, save=True)

        project = create_project_with_dataset(admin, dataset)
        project_model.setUserAccess(project, user, AccessType.READ, save=True)
        project = project_model.load(project['_id'], force=True)

        # User has READ on both - should pass
        assert project_model.hasResourceAccess(
            project, dataset['_id'], 'dataset', user, AccessType.READ
        )

        # User doesn't have WRITE on project - should fail
        assert not project_model.hasResourceAccess(
            project, dataset['_id'], 'dataset', user, AccessType.WRITE
        )


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestMultipleProjectsScenarios:
    """Test scenarios with multiple projects."""

    def test_same_dataset_different_projects(self, admin, user):
        """
        Test dataset in multiple projects with different permissions.

        User should get different access depending on which project context.
        """
        project_model = Project()
        dataset = create_dataset(admin)
        Folder().setUserAccess(dataset, user, AccessType.READ, save=True)

        # Project A: user has access
        project_a = create_project_with_dataset(admin, dataset, "project_a")
        project_model.setUserAccess(
            project_a, user, AccessType.READ, save=True
        )

        # Project B: user has NO access
        project_b = project_model.createProject(
            name="project_b",
            creator=admin,
            description="Test"
        )
        project_model.addDataset(project_b, dataset['_id'])

        # Through Project A - should work
        set_project_context(str(project_a['_id']))
        try:
            check_project_access_for_resource(
                user, dataset['_id'], 'dataset', AccessType.READ
            )
        finally:
            clear_project_context()

        # Through Project B - should fail
        set_project_context(str(project_b['_id']))
        try:
            with pytest.raises(AccessException):
                check_project_access_for_resource(
                    user, dataset['_id'], 'dataset', AccessType.READ
                )
        finally:
            clear_project_context()


@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestPrivatePublicCombinations:
    """Test private/public combinations of projects and datasets."""

    def test_private_dataset_public_project(self, admin, user):
        """
        Private dataset in public project stays private.

        User should NOT see the dataset even though project is public.
        The project permission masking only checks project access - the
        actual dataset access check happens separately.
        """
        project_model = Project()

        # Private dataset - explicitly set as non-public
        dataset = create_dataset(admin)
        Folder().setPublic(dataset, False, save=True)

        # Public project with dataset
        project = create_project_with_dataset(admin, dataset)
        project = project_model.setPublic(project, True, save=True)

        # User can access public project (use hasAccess to verify)
        assert project_model.hasAccess(project, user, AccessType.READ)

        # Through project context, the PROJECT check passes (project is public)
        set_project_context(str(project['_id']))
        try:
            # check_project_access_for_resource only verifies:
            # 1. User has project access (yes, project is public)
            # 2. Dataset is in the project (yes)
            # It does NOT check dataset permissions - that's separate
            check_project_access_for_resource(
                user, dataset['_id'], 'dataset', AccessType.READ
            )

            # The actual dataset access check verifies user doesn't have
            # direct dataset permissions
            assert not Folder().hasAccess(dataset, user, AccessType.READ)
        finally:
            clear_project_context()

    def test_public_dataset_private_project(self, admin, user):
        """
        Public dataset in private project.

        User should NOT access through project (blocked by project
        permissions). User CAN access dataset directly.
        """
        project_model = Project()

        # Public dataset
        dataset = create_dataset(admin)
        Folder().setPublic(dataset, True, save=True)

        # Private project (user has no access)
        project = create_project_with_dataset(admin, dataset)

        # User cannot access project (verify with hasAccess)
        assert not project_model.hasAccess(project, user, AccessType.READ)

        # Direct dataset access works (dataset is public)
        clear_project_context()
        loaded_dataset = Folder().load(
            dataset['_id'], user=user, level=AccessType.READ
        )
        assert loaded_dataset is not None

        # Through project context - should fail (user lacks project access)
        set_project_context(str(project['_id']))
        try:
            with pytest.raises(AccessException):
                check_project_access_for_resource(
                    user, dataset['_id'], 'dataset', AccessType.READ
                )
        finally:
            clear_project_context()

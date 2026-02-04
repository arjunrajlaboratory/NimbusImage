"""
Project context management for permission masking.

This module provides utilities to:
1. Extract project context from requests
2. Store context in thread-local state
3. Apply project permission masking when context is present

The permission masking model works as follows:
- Datasets/collections retain their individual ACL permissions
- Project permissions act as a higher-level mask
- When accessing through a project context, BOTH permissions must allow access
- When accessing directly (no project context), only resource permissions apply
"""

import threading
from functools import wraps

from bson import ObjectId
from girder.api.rest import getCurrentUser
from girder.constants import AccessType
from girder.exceptions import AccessException

# Thread-local storage for project context
_context = threading.local()


def set_project_context(project_id):
    """
    Set the current project context for this request.

    Args:
        project_id: The project ID (string or ObjectId)
    """
    if project_id:
        _context.project_id = str(project_id)
    else:
        _context.project_id = None


def get_project_context():
    """
    Get the current project context, or None if not set.

    Returns:
        The project ID as a string, or None if no context is set.
    """
    return getattr(_context, 'project_id', None)


def clear_project_context():
    """Clear the project context after request completes."""
    _context.project_id = None


def check_project_access_for_resource(user, resource_id, resource_type, level):
    """
    Check if user has access to a resource through the current project context.

    This function implements the permission masking logic:
    1. If no project context is set, returns True (no masking applied)
    2. If project context is set, verifies:
       - User has required access level on the project
       - The resource is actually a member of the project

    Args:
        user: The current user dict
        resource_id: The ID of the dataset or collection (string or ObjectId)
        resource_type: 'dataset' or 'collection'
        level: Required access level (AccessType.READ, WRITE, or ADMIN)

    Returns:
        True if access is allowed

    Raises:
        AccessException: If access is denied (insufficient project permissions
                        or resource is not in the project)
    """
    project_id = get_project_context()
    if not project_id:
        return True  # No project context, no masking

    # Import here to avoid circular imports
    from ..models.project import Project as ProjectModel
    project_model = ProjectModel()

    # Load project with required access level
    project = project_model.load(
        project_id, user=user, level=level, exc=False
    )

    if not project:
        raise AccessException(
            'Access denied: insufficient project permissions'
        )

    # Verify resource is in the project
    resource_id_obj = (
        ObjectId(resource_id) if isinstance(resource_id, str) else resource_id
    )

    if resource_type == 'dataset':
        in_project = any(
            d['datasetId'] == resource_id_obj
            for d in project['meta'].get('datasets', [])
        )
    elif resource_type == 'collection':
        in_project = any(
            c['collectionId'] == resource_id_obj
            for c in project['meta'].get('collections', [])
        )
    else:
        raise ValueError(f'Unknown resource type: {resource_type}')

    if not in_project:
        raise AccessException(
            f'Resource {resource_id} is not part of project {project_id}'
        )

    return True


def project_masked_access(resource_type, resource_id_param='datasetId',
                          level=AccessType.READ):
    """
    Decorator that applies project permission masking to an endpoint.

    When a request includes a project context (via X-Project-Id header),
    this decorator ensures the user has the required access level on both
    the project AND the resource. The most restrictive permission wins.

    Args:
        resource_type: 'dataset' or 'collection'
        resource_id_param: Name of parameter containing the resource ID
        level: Required access level (default: AccessType.READ)

    Usage:
        @project_masked_access('dataset', 'datasetId', AccessType.READ)
        def find(self, params):
            ...
    """
    def decorator(func):
        @wraps(func)
        def wrapper(self, *args, **kwargs):
            # Get resource ID from kwargs or params
            resource_id = kwargs.get(resource_id_param)

            # Check params dict if not in kwargs
            if resource_id is None and 'params' in kwargs:
                resource_id = kwargs['params'].get(resource_id_param)
            if resource_id is None and args:
                # Check first positional arg if it's a dict (params)
                if isinstance(args[0], dict):
                    resource_id = args[0].get(resource_id_param)

            if resource_id:
                user = getCurrentUser()
                check_project_access_for_resource(
                    user, resource_id, resource_type, level
                )

            return func(self, *args, **kwargs)
        return wrapper
    return decorator

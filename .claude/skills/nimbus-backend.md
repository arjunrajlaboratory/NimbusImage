# Nimbus Backend Development (Girder)

Guidelines for backend development in the NimbusImage Girder plugin.

## Technology Stack

- **Girder** - Python-based data management platform
- **MongoDB** - Document database
- **Docker** - Containerized deployment
- **Girder Worker** - Distributed task execution

## Key Files

- `devops/girder/plugins/AnnotationPlugin/` - Main plugin directory
- `upenncontrast_annotation/server/api/` - REST API endpoints
- `upenncontrast_annotation/server/models/` - Data models
- `upenncontrast_annotation/test/` - Test files

## Access Control

### Access Levels

Girder uses numeric access levels:

| Value | Constant | Meaning |
|-------|----------|---------|
| -1 | (none) | No access / Remove access |
| 0 | `AccessType.READ` | View-only access |
| 1 | `AccessType.WRITE` | Edit access |
| 2 | `AccessType.ADMIN` | Full control |

**Important:** Use `-1` (not `null`) to remove a user's access. This is Girder's convention and simplifies validation:

```python
# Good - use -1 to remove access
accessType = AccessType().validate(body["accessType"])  # Handles -1, 0, 1, 2

# Bad - don't use null/None for no access
if rawAccessType is None:
    accessType = None  # Unnecessary special case
```

### Access Decorators

Use `@access` decorators on all endpoints:

```python
from girder.api import access

@access.public      # Anyone can access
@access.user        # Requires authenticated user
@access.admin       # Requires admin privileges
```

### Model-Level Access

Use `level` parameter when loading documents:

```python
from girder.constants import AccessType

# Require specific access level
doc = Model().load(id, user=user, level=AccessType.WRITE, exc=True)

# For admin operations (bypass user permissions)
doc = Model().load(id, force=True)
```

## Database Queries

### Always Use Girder's Model.find()

**Never** use `Model().collection.find()` directly. Always use `Model().find()`:

```python
# Good - uses Girder's find with security features
docs = list(MyModel().find({
    '_id': {'$in': list(ids)}
}))

# Good - with field projection
users = list(User().find(
    {'_id': {'$in': userIds}},
    fields=['email', 'login']
))

# Bad - bypasses Girder's security (authorized fields, timeouts)
docs = list(MyModel().collection.find({
    '_id': {'$in': list(ids)}
}))
```

Girder's `Model().find()` adds:
- Query field authorization
- Query timeout protection
- Consistent cursor handling

### Permission-Aware Queries

For queries that should respect user permissions:

```python
# Use findWithPermissions for user-scoped queries
docs = model.findWithPermissions(
    query={'datasetId': dataset_id},
    user=self.getCurrentUser(),
    level=AccessType.READ,
    limit=limit,
    offset=offset
)
```

## Loading Documents

### Use exc=True

When loading a document that must exist, use `exc=True` to auto-raise:

```python
# Good - automatically raises if not found
doc = Model().load(id, user=user, level=AccessType.READ, exc=True)

# Bad - redundant null check
doc = Model().load(id, user=user, level=AccessType.READ)
if doc is None:
    raise RestException("Not found", 404)
```

### Model Parameters

Use `@modelParam` for automatic loading with access checks:

```python
@autoDescribeRoute(
    Description("Get something")
    .modelParam('id', 'The document ID', model=MyModel,
                level=AccessType.READ, destName='doc')
)
def get(self, doc):
    # doc is already loaded and access-checked
    return doc
```

## API Endpoint Patterns

### Route Registration

```python
class MyResource(Resource):
    def __init__(self):
        super().__init__()
        self.resourceName = "my_resource"

        self.route("GET", (":id",), self.get)
        self.route("POST", (), self.create)
        self.route("PUT", (":id",), self.update)
        self.route("DELETE", (":id",), self.delete)
        self.route("GET", (), self.find)
```

### Auto-Describe Routes

Use `@autoDescribeRoute` for automatic Swagger documentation:

```python
@access.user
@autoDescribeRoute(
    Description("Create a new thing")
    .notes("""
        Detailed explanation of what this endpoint does.
        Can span multiple lines.
    """)
    .jsonParam("body", "Request body", paramType="body",
               schema={...}, required=True)
    .errorResponse("ID was invalid.")
    .errorResponse("Write access denied.", 403)
)
def create(self, body):
    ...
```

### Bulk Operations

When the frontend needs to operate on multiple items, create bulk endpoints:

```python
@access.user
@autoDescribeRoute(
    Description("Bulk create items (READ OPERATION via POST)")
    .notes("Uses POST to avoid URL length limits with large arrays")
    .jsonParam("body", "Array of items", paramType="body")
)
def createBulk(self, body):
    items = body.get('items', [])
    return [self._model.create(item) for item in items]
```

## Testing

### Test Structure

Tests use pytest with Girder fixtures:

```python
import pytest
import random
from girder.exceptions import AccessException
from . import girder_utilities as utilities
from . import upenn_testing_utilities as upenn_utilities

@pytest.mark.usefixtures("unbindLargeImage", "unbindAnnotation")
@pytest.mark.plugin("upenncontrast_annotation")
class TestMyFeature:
    def testSomething(self, admin, user):
        # admin fixture provides authenticated admin user
        # user fixture provides authenticated regular user
        folder = utilities.createFolder(admin, "name", metadata)
        # ... test logic
```

### Running Tests

```bash
cd devops/girder/plugins/AnnotationPlugin
tox        # Run all tests
tox -r     # Recreate environment (after dependency changes)
```

### Test Utilities

- `girder_utilities.py` - Folder creation helpers
- `upenn_testing_utilities.py` - Sample data generators (annotations, connections)
- `conftest.py` - Pytest fixtures (unbind handlers to avoid conflicts)

### Key Testing Patterns

**Use unique names for test resources:**
```python
# Girder requires unique folder names within a parent
unique_name = f"test_dataset_{random.random()}"
folder = utilities.createFolder(user, unique_name, metadata)
```

**Testing access control - use `pytest.raises` for AccessException:**
```python
# When user lacks access, Girder raises AccessException (not None)
with pytest.raises(AccessException):
    Model().load(doc_id, user=user, level=AccessType.WRITE)
```

**Available fixtures:**
- `admin` - Admin user with full privileges
- `user` - Regular user (non-admin)
- `db` - Database fixture (for tests not requiring users)

**Test data helpers:**
```python
from . import upenn_testing_utilities as upenn_utilities

# Sample annotation
annotation = upenn_utilities.getSampleAnnotation(dataset_id)

# Sample connection
connection = upenn_utilities.getSampleConnection(parent_id, child_id, dataset_id)

# Dataset metadata (required for dataset folders)
metadata = upenn_utilities.datasetMetadata  # {"subtype": "contrastDataset"}
```

**Testing public/private access:**
```python
# Folders may be public by default depending on parent
# Always explicitly set the state you need to test
Folder().setPublic(folder, False, save=True)  # Make private first
# ... then test making it public
```

**Helper function pattern for creating test data:**
```python
def createDatasetWithView(creator):
    """Create a complete test dataset with config and view."""
    unique_name = f"test_dataset_{random.random()}"
    dataset = utilities.createFolder(creator, unique_name, metadata)

    config = Collection().createCollection(
        name=f"config_{random.random()}",
        creator=creator,
        folder=dataset,
        metadata={...}
    )

    view = DatasetViewModel().create(creator, {
        "datasetId": dataset["_id"],
        "configurationId": config["_id"],
        ...
    })

    return dataset, config, view
```

## Common Patterns

### Setting User Access

```python
# Grant access
Model().setUserAccess(doc, targetUser, AccessType.WRITE, save=True)

# Remove access (use -1, not None)
Model().setUserAccess(doc, targetUser, -1, save=True)
```

### Setting Public Access

```python
Model().setPublic(doc, public=True, save=True)
```

### Getting Access Lists

```python
# Get full access list with user details populated
accessList = Model().getFullAccessList(doc)
# Returns: {'users': [...], 'groups': [...]}
```

### ObjectId Handling

```python
from bson import ObjectId

# Convert string to ObjectId for queries
query = {'_id': ObjectId(string_id)}

# Handle arrays
query = {'_id': {'$in': [ObjectId(id) for id in string_ids]}}
```

## Error Handling

```python
from girder.exceptions import RestException, ValidationException, AccessException

# Client errors
raise RestException("Bad request message", code=400)

# Validation errors
raise ValidationException("Field X is invalid")

# Access errors
raise AccessException("Permission denied")
```

## Logging

```python
from girder import logprint

logprint.info("Informational message")
logprint.warning("Warning message")
logprint.error(f"Error: {details}")
```

## Docker Development

```bash
# Rebuild after backend changes
docker compose down
docker compose build
docker compose up -d

# View logs
docker compose logs -f girder
```

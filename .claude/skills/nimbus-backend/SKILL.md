---
name: nimbus-backend
description: "Use when writing or modifying Python code in the Girder backend plugin (devops/girder/plugins/AnnotationPlugin/), creating REST API endpoints, writing database queries with MongoDB, implementing access control and sharing, running backend tests with tox/pytest, or debugging Docker compose services. Covers: API endpoint patterns (@autoDescribeRoute, modelParam), access control (AccessType, setUserAccess, setPublic), database queries (Model.find vs collection.find), model loading patterns, error handling, and backend test patterns."
---

# Nimbus Backend Development (Girder)

## Access Control

### Access Levels (Document-Level)

| Value | Constant | Meaning |
|-------|----------|---------|
| -1 | (none) | No access / Remove access |
| 0 | `AccessType.READ` | View-only access |
| 1 | `AccessType.WRITE` | Edit access |
| 2 | `AccessType.ADMIN` | Owner — can manage access (share, set public, delete) |

**Important:** `AccessType.ADMIN` means **owner of that document**, not a site-wide admin. The creator of a project/dataset gets ADMIN on it and can share it with others.

Use `-1` (not `null`) to remove a user's access.

### Access Decorators (Endpoint-Level)

```python
from girder.api import access

@access.public      # Anyone can access
@access.user        # Requires authenticated user
@access.admin       # Requires site-wide Girder admin (NOT document owner)
```

**Note:** `@access.admin` (decorator) and `AccessType.ADMIN` (document level) are different. The decorator requires site-wide admin; the access level means document owner.

### Model-Level Access

```python
from girder.constants import AccessType

doc = Model().load(id, user=user, level=AccessType.WRITE, exc=True)
doc = Model().load(id, force=True)  # Admin bypass
```

For detailed access patterns including sharing: read `references/access-control-patterns.md`
When modifying sharing/access code: read `codebaseDocumentation/SHARING.md`

## Model Parameters: Security

### modelParam vs param

Always use `modelParam` when accepting IDs that reference resources requiring access control:

```python
# Good - validates existence AND checks WRITE access
.modelParam('datasetId', model=Folder, level=AccessType.WRITE,
            destName='dataset', paramType='formData')

# Bad - no validation, no access check
.param('datasetId', 'Dataset ID to add.', paramType='formData')
```

Use `.param()` only for simple string/number values, enums, or search filters.

### Plugin Models vs Girder Built-in Models

| Resource | Plugin Model | NOT Girder's |
|----------|--------------|--------------|
| Datasets | `Folder` (Girder) | - |
| Collections/Configs | `Collection` (plugin) | `Item` |
| Projects | `Project` (plugin) | - |
| Annotations | `Annotation` (plugin) | - |
| Dataset Views | `DatasetView` (plugin) | - |

```python
# Good - uses plugin's Collection model
from upenncontrast_annotation.server.models.collection import Collection
.modelParam('collectionId', model=Collection, level=AccessType.WRITE, ...)

# Bad - Girder's Item model won't find plugin collections!
from girder.models.item import Item
.modelParam('collectionId', model=Item, level=AccessType.WRITE, ...)
```

## Database Queries

**Always use `Model().find()`**, never `Model().collection.find()`:

```python
docs = list(MyModel().find({'_id': {'$in': list(ids)}}))

# With field projection
users = list(User().find(
    {'_id': {'$in': userIds}},
    fields=['email', 'login']
))
```

For detailed query patterns: read `references/database-query-patterns.md`

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

```python
@access.user
@autoDescribeRoute(
    Description("Create a new thing")
    .notes("Detailed explanation.")
    .jsonParam("body", "Request body", paramType="body",
               schema={...}, required=True)
    .errorResponse("ID was invalid.")
    .errorResponse("Write access denied.", 403)
)
def create(self, body):
    ...
```

### Bulk Operations

```python
@access.user
@autoDescribeRoute(
    Description("Bulk create items (READ OPERATION via POST)")
    .notes("Uses POST to avoid URL length limits")
    .jsonParam("body", "Array of items", paramType="body")
)
def createBulk(self, body):
    items = body.get('items', [])
    return [self._model.create(item) for item in items]
```

## ObjectId Handling

```python
from bson import ObjectId

query = {'_id': ObjectId(string_id)}
query = {'_id': {'$in': [ObjectId(id) for id in string_ids]}}
```

Note: `Model().load()` handles ObjectId conversion internally.

## Error Handling

```python
from girder.exceptions import (
    RestException, ValidationException, AccessException
)

raise RestException("Bad request message", code=400)
raise ValidationException("Field X is invalid")
raise AccessException("Permission denied")
```

## Logging

```python
from girder import logprint

logprint.info("Informational message")
logprint.warning("Warning message")
logprint.error(f"Error: {details}")
```

## Testing

For detailed testing patterns beyond basics: read `references/testing-patterns.md`

Testing basics (running tox, test structure, linting): see `CLAUDE.md`

## Codebase Documentation References

- When modifying sharing/access code: read `codebaseDocumentation/SHARING.md`
- When modifying project backend code: read `codebaseDocumentation/PROJECTS.md`

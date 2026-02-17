# Access Control Patterns (Detailed)

## Access Levels

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

## Setting User Access

```python
# Grant access
Model().setUserAccess(doc, targetUser, AccessType.WRITE, save=True)

# Remove access (use -1, not None)
Model().setUserAccess(doc, targetUser, -1, save=True)
```

## Setting Public Access

```python
Model().setPublic(doc, public=True, save=True)
```

## Getting Access Lists

```python
# Get full access list with user details populated
accessList = Model().getFullAccessList(doc)
# Returns: {'users': [...], 'groups': [...]}
```

## Sharing Pattern (Multi-Resource Permissions)

When sharing a dataset, permissions must be set on multiple resources simultaneously:

```
Dataset Folder ──> DatasetView ──> Configuration
   All three receive the same permissions
```

Resources affected by sharing:
1. **Dataset Folder** - The main folder containing the dataset
2. **DatasetViews** - User-specific view configurations
3. **Configurations (Collections)** - Tool definitions, layer settings, scales

### Share Endpoint Pattern

```python
@access.user
@autoDescribeRoute(
    Description("Share dataset views with a user")
    .jsonParam("body", "Share request", paramType="body",
               schema={
                   "datasetViewIds": ["id1", "id2"],
                   "userMailOrUsername": "user@example.com",
                   "accessType": 0  # 0=READ, 1=WRITE, -1=remove
               })
)
def share(self, body):
    # 1. Resolve user by email or username
    # 2. For each DatasetView:
    #    - Set access on the DatasetView
    #    - Set access on the parent Dataset folder
    #    - Set access on associated Configurations
```

### Public Access Pattern

Making resources public/private affects the entire chain:

```python
@access.user
@autoDescribeRoute(
    Description("Set dataset public/private")
    .modelParam('datasetId', 'The dataset folder ID', model=Folder,
                level=AccessType.ADMIN, destName='dataset')
    .param('public', 'Whether to make public', dataType='boolean',
           required=True)
)
def setDatasetPublic(self, dataset, public):
    # Set public on: dataset folder + all DatasetViews + all Configurations
    Folder().setPublic(dataset, public, save=True)
    for view in datasetViews:
        DatasetViewModel().setPublic(view, public, save=True)
    for config in configurations:
        Collection().setPublic(config, public, save=True)
```

### Access Check: Owner Protection

ADMIN users (dataset creators) cannot be removed from the access list:

```python
# Check before removing access
if targetUser['_id'] == doc.get('creatorId'):
    raise RestException("Cannot remove owner's access")
```

## Reference

For full sharing implementation details, read: `codebaseDocumentation/SHARING.md`

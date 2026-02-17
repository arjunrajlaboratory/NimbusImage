# Backend Testing Patterns (Detailed)

## Test Structure

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

## Unique Names for Test Resources

Girder requires unique folder names within a parent. Always use random suffixes:

```python
unique_name = f"test_dataset_{random.random()}"
folder = utilities.createFolder(user, unique_name, metadata)
```

## Testing Access Control

Use `pytest.raises` for `AccessException` - Girder raises exceptions, not None:

```python
# When user lacks access, Girder raises AccessException (not None)
with pytest.raises(AccessException):
    Model().load(doc_id, user=user, level=AccessType.WRITE)
```

## Testing Public/Private Access

Folders may be public by default depending on parent. Always explicitly set the state:

```python
# Always explicitly set the state you need to test
Folder().setPublic(folder, False, save=True)  # Make private first
# ... then test making it public
```

## Available Fixtures

- `admin` - Admin user with full privileges
- `user` - Regular user (non-admin)
- `db` - Database fixture (for tests not requiring users)

## Test Data Helpers

```python
from . import upenn_testing_utilities as upenn_utilities

# Sample annotation
annotation = upenn_utilities.getSampleAnnotation(dataset_id)

# Sample connection
connection = upenn_utilities.getSampleConnection(
    parent_id, child_id, dataset_id
)

# Dataset metadata (required for dataset folders)
metadata = upenn_utilities.datasetMetadata
# {"subtype": "contrastDataset"}
```

## Helper Function Pattern

Create reusable test data builders for complex setups:

```python
def createDatasetWithView(creator):
    """Create a complete test dataset with config and view."""
    unique_name = f"test_dataset_{random.random()}"
    dataset = utilities.createFolder(
        creator, unique_name, metadata
    )

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

## Testing Sharing/Permissions

Pattern for testing that access control works correctly:

```python
def testAccessControl(self, admin, user):
    # Create resource as admin
    dataset = createDataset(admin)

    # Verify user cannot access without permission
    with pytest.raises(AccessException):
        Model().load(
            dataset['_id'], user=user,
            level=AccessType.READ
        )

    # Grant access
    Model().setUserAccess(
        dataset, user, AccessType.READ, save=True
    )

    # Verify user can now access
    loaded = Model().load(
        dataset['_id'], user=user,
        level=AccessType.READ
    )
    assert loaded is not None

    # Verify user still can't write
    with pytest.raises(AccessException):
        Model().load(
            dataset['_id'], user=user,
            level=AccessType.WRITE
        )
```

# Database Query Patterns (Detailed)

## Always Use Model.find()

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

## Permission-Aware Queries

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

## ObjectId Handling

```python
from bson import ObjectId

# Convert string to ObjectId for queries
query = {'_id': ObjectId(string_id)}

# Handle arrays
query = {'_id': {'$in': [ObjectId(id) for id in string_ids]}}
```

**Note:** `Model().load()` handles ObjectId conversion internally, so you don't need to wrap IDs in `ObjectId()` when using `load()`.

## MongoDB Index Patterns

The plugin defines indices on commonly queried fields:

```python
class MyModel(ProxiedModel):
    def initialize(self):
        self.ensureIndices([
            'creatorId',
            'lowerName',
            'meta.datasetId',
        ])
```

When adding new query patterns that filter on specific fields, check if an index exists or should be created.

## Batch Query Patterns

When fetching multiple documents by ID, use `$in` queries instead of individual loads. This is the **single most common code review issue** in this project.

```python
# Good - single query for multiple documents
docs = list(MyModel().find({
    '_id': {'$in': [ObjectId(id) for id in ids]}
}))

# Bad - N individual queries (NEVER do this)
docs = [MyModel().load(id) for id in ids]

# Bad - looped loads
for id in ids:
    doc = MyModel().load(id, user=user, level=AccessType.READ)
    # ... process

# Bad - looped saves
for doc in docs:
    MyModel().setUserAccess(doc, user, AccessType.WRITE, save=True)
```

When Girder doesn't provide a built-in batch method (e.g., batch `setUserAccess`), **implement one** rather than looping. Use `update_many` or `bulk_write` on the collection for bulk updates — this is one of the accepted exceptions to the "no direct collection access" rule (see [Aggregation Queries](#aggregation-queries) note).

### Avoiding Redundant Fetches

If data was already fetched earlier in the call chain, pass it as a parameter instead of re-fetching:

```python
# Bad - re-fetching data we already have
def process_datasets(dataset_ids, user):
    datasets = [Folder().load(id) for id in dataset_ids]  # fetch #1
    for ds in datasets:
        _validate_dataset(ds['_id'])  # fetches again inside!

# Good - pass already-loaded data
def process_datasets(dataset_ids, user):
    datasets = list(Folder().find({
        '_id': {'$in': [ObjectId(id) for id in dataset_ids]}
    }))
    for ds in datasets:
        _validate_dataset(ds)  # uses already-loaded data
```

## Aggregation Queries

For complex queries that need grouping or computed fields:

```python
# Use Model().collection for aggregation pipelines only
pipeline = [
    {'$match': {'datasetId': ObjectId(dataset_id)}},
    {'$group': {'_id': '$type', 'count': {'$sum': 1}}}
]
results = list(MyModel().collection.aggregate(pipeline))
```

**Note:** Direct `collection` access is acceptable for operations that Girder's Model API doesn't support: aggregation pipelines (above) and bulk writes like `update_many`/`bulk_write` for batch permission updates (see [Batch Query Patterns](#batch-query-patterns)). For all other read/write operations, use Model methods.

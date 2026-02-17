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

When fetching multiple documents by ID, use `$in` queries instead of individual loads:

```python
# Good - single query for multiple documents
docs = list(MyModel().find({
    '_id': {'$in': [ObjectId(id) for id in ids]}
}))

# Bad - N individual queries
docs = [MyModel().load(id) for id in ids]
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

**Note:** Aggregation is the one case where `collection` access is acceptable, since Girder's `find()` doesn't support aggregation pipelines.

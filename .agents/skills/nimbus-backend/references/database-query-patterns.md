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

### Projecting fields is safe with findWithPermissions

`findWithPermissions` accepts `fields=` and forwards it to `find()` as the Mongo projection. It is safe to project away `access` and `public`: the method builds `{'$and': [query, self.permissionClauses(user, level)]}` and hands that to `find()`, so permission filtering happens **inside the Mongo query**, not in Python over the returned documents. Nothing post-filters on fields you excluded.

This matters for listing endpoints on models with a fat subdocument (`upenn_collection.meta` holds layers, tools, snapshots). Projecting to a summary tuple is the difference between a listing that scales to thousands of rows and one that can't be used across folders at all:

```python
COLLECTION_SUMMARY_FIELDS = (
    '_id', 'name', 'description', 'folderId', 'creatorId', 'created', 'updated',
)

documents = list(model.findWithPermissions(
    query, offset=offset, limit=limit + 1, sort=sort,
    fields=COLLECTION_SUMMARY_FIELDS, user=self.getCurrentUser(),
))
return {
    'collections': [
        {f: d.get(f) for f in COLLECTION_SUMMARY_FIELDS}
        for d in documents[:limit]
    ],
    'hasMore': len(documents) > limit,
}
```

Keep `_id` **in** the field tuple rather than special-casing it around the comprehension.

**No reliable `count()`.** The docstring says the return "may be a CommandCursor augmented with a count function," but the non-admin path returns a plain PyMongo cursor, and `Cursor.count()` was removed in PyMongo 4. Don't build a response contract on it. Fetch `limit + 1` documents and report `hasMore = len(documents) > limit` instead — one query, no count aggregation. See the SKILL.md warning about how `limit + 1` interacts with Girder's `limit=0`-means-unlimited sentinel.

**Index the complete sort.** A cross-folder listing sorted on an unindexed key
makes Mongo blocking-sort every accessible document. Offset paging also needs a
total order, so append `_id` to every supported sort and its matching index.
The `(updated, _id)` compound still serves a plain `updated` prefix query, so a
separate single-field `updated` index is redundant:

```python
self.ensureIndices((
    'folderId', 'name', 'lowerName',
    ([('updated', -1), ('_id', -1)], {}),
    ([('folderId', 1), ('name', 1), ('_id', 1)], {}),
    ([('folderId', 1), ('updated', -1), ('_id', -1)], {}),
))
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

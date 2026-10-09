# Unique `annotationId` index on `annotation_property_values`

PR #1347 made `AnnotationPropertyValues.__init__` enforce one values document per
annotation with a **unique** `annotationId_1` index. That is the right invariant, but
the startup migration that establishes it is unsafe on a large or duplicated
collection. This document records what happened in production, the operator procedure
that must run before deploying #1347-or-later code to such an install, and the general
rule for index changes.

## What the startup code does

```python
previousIndex = self.collection.index_information().get('annotationId_1')
if previousIndex and not previousIndex.get('unique'):
    self.collection.drop_index('annotationId_1')
try:
    self.collection.create_index(self.annotationIndex, unique=True)
except DuplicateKeyError:
    self._coalesceDuplicateDocuments()
    self.collection.create_index(self.annotationIndex, unique=True)
```

It runs in every uvicorn worker (production runs 9) on every Girder start.

- **Index already unique:** no drop; `create_index` is an instant no-op. Safe.
- **Non-unique index on a small collection:** drops, rebuilds unique in well under the
  60 s client socket timeout. Safe.
- **Non-unique index on a large collection:** unsafe. See below.

## Production incident, 2026-10-09

The collection held 35.5M documents (Atlas M20, MongoDB 8.0). Rolling a Girder backend
to #1347:

1. One worker dropped `annotationId_1`; the others hit `IndexNotFound` racing the drop.
2. The unique build takes ~3.2 min; every worker hit the 60 s `socketTimeoutMS`, raised
   `TimeoutError`, crashed and restarted. Girder never served. The coalesce branch never
   ran, because the client never saw a `DuplicateKeyError`.
3. The crash-looping workers queued **72** `createIndexes` requests. Mongo kept running
   them **one after another for ~4 h after the instance was terminated**, each a fresh
   build that failed on `E11000` for the same duplicate annotation.
4. Net: the collection had **no `annotationId` index for 6 h**. Every lookup by
   `annotationId` was a full collection scan (one took over 60 s). Traffic was
   overnight-low, so impact was limited.

Recovery: recreate the plain index (~3 min, server-side; the client timeout does not
stop it), dedup with the script below, rebuild the index unique, then deploy #1347
unchanged. Its startup then takes the safe "already unique" path.

### The duplicates

| | |
|---|---|
| annotationIds with duplicates | 764,822 (731,140 × 2 docs, 33,682 × 3) |
| surplus documents | 798,504 of 35,533,334 (2.2%) |
| copies hold different properties | 407,141 groups |
| copies overlap, same values | 338,357 |
| exact copies | 14,566 |
| copies **disagree** on a value | 4,758 (0.6%) |
| datasets affected | 141, every group within one dataset |
| created after the #1356 fix shipped (2026-10-06) | **0** |

These are legacy: the pre-#1356 read-merge-write path raced (see the `nimbus-backend`
skill, "Concurrent writers"). Reads could return whichever copy came first and writes
updated only one of them, so values appeared to vanish or go stale.

## Operator procedure (before deploying #1347+ to a large install)

The script is `devops/girder/scripts/dedup_property_values.py`. It is not baked into the
image; copy it into the running `girder` container, which has the DB configuration:

```bash
docker cp devops/girder/scripts/dedup_property_values.py girder:/tmp/

# 1. Report: duplicate count, group sizes, how the copies relate. Read-only.
docker exec girder python /tmp/dedup_property_values.py

# 2. Merge. Backs up every affected document first; safe to re-run.
docker exec girder python /tmp/dedup_property_values.py --apply

# 3. Rebuild annotationId_1 as unique (refuses while duplicates remain).
docker exec girder python /tmp/dedup_property_values.py --make-unique
```

Then deploy. If the collection is small and has no duplicates, the startup migration
is fine on its own; run step 1 to find out.

- **Merge rule:** each group is merged into its **oldest** document. The `values` dicts
  are deep-merged; on a conflicting leaf the **newest** document (largest `_id`) wins,
  which is what a single document would hold had the race never happened. This differs
  from the startup `_coalesceDuplicateDocuments`, which keeps the oldest value.
- **Backup:** originals of every merged group (keepers included) go to
  `annotation_property_values_dedup_backup_<YYYYMMDD>` (override with
  `--backup-collection`). Drop it once you're satisfied.
- **Cost:** the duplicate scan streams the `annotationId` index from a secondary
  (~80 s for 35M docs). The merge ran at ~190 groups/s (68 min for 765k groups) at the
  default `--batch-size 2000`.
- **Index gap:** `--make-unique` drops the plain index before building the unique one,
  so lookups are unindexed for the build (~3 min at 35M docs). Run it in a quiet window.
  It waits for the server-side build, and restores the plain index if the unique build
  fails. A DB user with `collMod` can avoid the gap by converting in place
  (`collMod` `prepareUnique: true`, then `unique: true`); the production app user cannot.

## Index changes on large collections: the rule

Never establish an index from a model `__init__` (or anything else that runs at Girder
startup) when the collection could be large:

- Startup runs in **every uvicorn worker at once**: drops and builds race each other.
- Builds outlive the **60 s client socket timeout**; the worker crashes, the build does
  not stop, and each restart queues another build.
- **Drop-then-build leaves no index** if the build fails or takes long; a unique build
  fails outright on existing duplicates.
- Our production app DB user cannot see `currentOp` or index-build progress, and cannot
  run `collMod`.

Ship index changes as an operator step (a script like this one, run once, verified),
and keep the old index in place until its replacement exists. `ensureIndices` on a
**new**, empty collection is fine.

## Useful read-only checks

```python
from girder.models import getDbConnection
db = getDbConnection().get_default_database()
db.command('collStats', 'annotation_property_values').get('indexBuilds')  # [] when idle
db.annotation_property_values.index_information()['annotationId_1']
# Query plan WITHOUT running the query. pymongo's cursor.explain() EXECUTES it
# (a full scan when unindexed):
db.command('explain', {'find': 'annotation_property_values',
                       'filter': {'annotationId': some_id}},
           verbosity='queryPlanner')['queryPlanner']['winningPlan']
```

`IXSCAN` / `EXPRESS_IXSCAN` means indexed; `COLLSCAN` means it is not.

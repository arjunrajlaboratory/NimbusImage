"""Operator tool: one annotation_property_values document per annotation.

See codebaseDocumentation/PROPERTY_VALUES_UNIQUE_INDEX.md. The pre-#1356
property-value write path raced, leaving some annotations with two or three
values documents. AnnotationPropertyValues.__init__ (PR #1347) enforces a
UNIQUE ``annotationId_1`` index at Girder startup by dropping a non-unique
one and rebuilding it. On a large collection that rebuild outlasts the
client socket timeout in every uvicorn worker, and with duplicates present
it can never succeed: on 2026-10-09 it left production with no
annotationId index for 6 h.

Run this BEFORE deploying a #1347-or-later backend to an install with a
large or duplicated collection. Once the index is unique, the startup code
skips the drop and its ``create_index`` is an instant no-op.

This script deliberately does not import the AnnotationPropertyValues
model: instantiating it runs that same startup migration.

Usage, inside the running girder container (which has the DB config)::

    S=/src/AnnotationPlugin/upenncontrast_annotation/scripts
    docker exec girder python $S/dedup_property_values.py            # report
    docker exec girder python $S/dedup_property_values.py --apply
    docker exec girder python $S/dedup_property_values.py --make-unique

``--apply`` merges each duplicate group into its OLDEST document. The
``values`` dicts are merged per property; where copies disagree, the most
recently CREATED copy (largest ``_id``) wins. The keeper's ``datasetId``
is set from the live annotation. Every document of every merged group,
keeper included, is first copied to the backup collection, so the merge
is reversible. Writes are guarded: the keeper only gains the properties the
merge changed, and an extra is deleted only if it is unchanged since it was
read, so a concurrent write is never lost -- a group that changed mid-merge
is left for the next run. Re-running is safe and resumes an interrupted
run; pass the same ``--backup-collection``.

``--make-unique`` refuses to run while duplicates remain or an index build
is in progress. It drops the non-unique ``annotationId_1`` and builds it
unique, waiting on the server-side build past the client socket timeout.
Whatever happens after the drop, it ends by making sure an annotationId
index exists, restoring the plain one if the unique build failed. Lookups
by annotationId are unindexed while it builds (~3 min for 35M documents on
an Atlas M20): run it in a quiet window. A DB user allowed ``collMod`` can
convert in place instead (``prepareUnique``, then ``unique``) with no gap;
the production app user is not.
"""
import argparse
import collections
import copy
import sys
import time

from pymongo import DeleteOne, ReadPreference, UpdateOne
from pymongo.errors import BulkWriteError, PyMongoError

from girder.models import getDbConnection

COLLECTION = 'annotation_property_values'
ANNOTATIONS = 'upenn_annotation'
INDEX_NAME = 'annotationId_1'
INDEX_KEY = [('annotationId', 1)]
DEFAULT_BACKUP = 'annotation_property_values_dedup_backup'
DUPLICATE_KEY_ERROR = 11000


def log(*args):
    print(time.strftime('%H:%M:%S'), *args, flush=True)


def requireIndex(coll):
    if coll.index_information().get(INDEX_NAME) is None:
        log('%s has no %s index. Recreate it first (plain, non-unique):'
            % (coll.name, INDEX_NAME))
        log("  create_index([('annotationId', 1)])  -- the build continues "
            'server-side if the client times out')
        sys.exit(2)


def findDuplicateIds(coll, readPreference=ReadPreference.PRIMARY):
    """Return (annotationIds with more than one document, null count).

    Streams the annotationId index in key order and counts adjacent
    repeats: a covered index scan (~80 s for 35M documents) with no
    server-side memory pressure, unlike a $group over the collection.
    Documents without an annotationId are counted, never grouped.
    """
    cursor = (coll.with_options(read_preference=readPreference)
              .find({}, {'annotationId': 1, '_id': 0})
              .sort('annotationId', 1)
              .hint(INDEX_NAME)
              .batch_size(20000))
    previous, run, duplicates, nulls = None, 0, [], 0
    for document in cursor:
        annotationId = document.get('annotationId')
        if annotationId is None:
            nulls += 1
            continue
        if run and annotationId == previous:
            run += 1
            continue
        if run > 1:
            duplicates.append(previous)
        previous, run = annotationId, 1
    if run > 1:
        duplicates.append(previous)
    return duplicates, nulls


def mergedValues(documents):
    """Merge a group's values per property, oldest to newest by _id.

    Property ids are the top-level keys, which is the granularity the app
    writes at. Nested dicts are deep-merged; on a conflicting leaf the
    newer document wins. Inputs are never aliased.
    """
    def merge(target, source):
        for key, value in source.items():
            if isinstance(value, dict) and isinstance(target.get(key), dict):
                merge(target[key], value)
            else:
                target[key] = value

    merged = {}
    for document in sorted(documents, key=lambda d: d['_id']):
        merge(merged, copy.deepcopy(document.get('values') or {}))
    return merged


def leaves(values, prefix=''):
    if isinstance(values, dict) and values:
        for key, value in values.items():
            yield from leaves(value, prefix + '/' + key)
    else:
        yield prefix, values


def classify(documents):
    """Describe how a group's copies relate, for the report."""
    maps = [dict(leaves(d.get('values') or {})) for d in documents]
    if all(m == maps[0] for m in maps):
        return 'identical'
    counts = collections.Counter(key for m in maps for key in m)
    shared = [key for key, count in counts.items() if count > 1]
    if not shared:
        return 'disjoint'
    if any(len({repr(m[key]) for m in maps if key in m}) > 1
           for key in shared):
        return 'conflicting'
    return 'overlap_same_values'


def planGroup(documents, liveDatasetId, stats):
    """Return the guarded write operations that merge one group."""
    documents.sort(key=lambda d: d['_id'])
    keeper, extras = documents[0], documents[1:]
    stats['groups'] += 1
    stats['size_%d' % len(documents)] += 1
    stats[classify(documents)] += 1
    if len({d.get('datasetId') for d in documents}) > 1:
        stats['mixed_datasetId'] += 1

    keeperValues = keeper.get('values') or {}
    merged = mergedValues(documents)
    changes = {
        'values.%s' % propertyId: value
        for propertyId, value in merged.items()
        if keeperValues.get(propertyId) != value
    }
    if liveDatasetId is None:
        stats['annotation_missing'] += 1
    elif keeper.get('datasetId') != liveDatasetId:
        changes['datasetId'] = liveDatasetId
        stats['datasetId_corrected'] += 1

    operations = []
    if changes:
        # Property-level $set: a concurrent write to another property of
        # the keeper survives.
        operations.append(UpdateOne({'_id': keeper['_id']},
                                    {'$set': changes}))
    for extra in extras:
        # Delete only an unchanged extra; a changed one stays and the next
        # run merges it.
        operations.append(DeleteOne({'_id': extra['_id'],
                                     'values': extra.get('values')}))
    stats['documents_to_delete'] += len(extras)
    return operations


def dedup(db, backupName, batchSize, apply):
    coll = db[COLLECTION]
    requireIndex(coll)
    start = time.time()
    duplicates, nulls = findDuplicateIds(
        coll, ReadPreference.SECONDARY_PREFERRED)
    log('annotationIds with duplicate documents: %d; documents without an '
        'annotationId: %d (scan %.0fs)'
        % (len(duplicates), nulls, time.time() - start))
    if not duplicates:
        return 0

    stats = collections.Counter()
    batches = (len(duplicates) + batchSize - 1) // batchSize
    for batchIndex in range(batches):
        ids = duplicates[batchIndex * batchSize:(batchIndex + 1) * batchSize]
        groups = collections.defaultdict(list)
        # Primary reads: merge the freshest data.
        for document in coll.find({'annotationId': {'$in': ids}}):
            groups[document['annotationId']].append(document)
        liveDatasetIds = {
            a['_id']: a.get('datasetId')
            for a in db[ANNOTATIONS].find({'_id': {'$in': ids}},
                                          {'datasetId': 1})}
        backups, operations = [], []
        for annotationId, documents in groups.items():
            if len(documents) < 2:
                stats['already_single'] += 1
                continue
            backups.extend(documents)
            operations.extend(planGroup(
                documents, liveDatasetIds.get(annotationId), stats))
        if apply and operations:
            try:
                db[backupName].insert_many(backups, ordered=False)
            except BulkWriteError as error:
                # A resumed run re-backs-up documents the interrupted run
                # saved; those collide on _id, keeping the true original.
                # Anything else stops before an unbacked document is
                # deleted.
                writeErrors = error.details.get('writeErrors') or []
                if any(e.get('code') != DUPLICATE_KEY_ERROR
                       for e in writeErrors):
                    raise
            result = coll.bulk_write(operations, ordered=True)
            stats['modified'] += result.modified_count
            stats['deleted'] += result.deleted_count
        log('batch %d/%d %s' % (batchIndex + 1, batches, dict(stats)))

    log('%s: %s in %.0fs' % (
        'merged' if apply else 'report only, nothing written',
        dict(stats), time.time() - start))
    if not apply:
        return len(duplicates)
    if stats['deleted'] < stats['documents_to_delete']:
        log('%d documents changed during the merge and were kept; '
            're-run --apply' % (stats['documents_to_delete'] -
                                stats['deleted']))
    remaining, _ = findDuplicateIds(coll)
    log('annotationIds still duplicated after merge: %d' % len(remaining))
    return len(remaining)


def indexState(db):
    builds = db.command('collStats', COLLECTION).get('indexBuilds') or []
    return builds, db[COLLECTION].index_information().get(INDEX_NAME)


def buildIndexAndWait(db, **options):
    try:
        db[COLLECTION].create_index(INDEX_KEY, name=INDEX_NAME, **options)
    except PyMongoError as error:
        # The build outlives the client's socket timeout but continues
        # server-side; the wait below sees it through. A real failure
        # shows up as a missing index afterwards.
        log('create_index raised %s; waiting on the server-side build'
            % type(error).__name__)
    while indexState(db)[0]:
        time.sleep(10)
    return indexState(db)[1]


def makeUnique(db):
    coll = db[COLLECTION]
    requireIndex(coll)
    builds, index = indexState(db)
    if builds:
        log('index builds already in progress: %s; not touching it' % builds)
        return 1
    if index.get('unique'):
        log('%s is already unique; nothing to do' % INDEX_NAME)
        return 0
    remaining, nulls = findDuplicateIds(coll)
    if remaining:
        log('%d annotationIds still have duplicates; run --apply first'
            % len(remaining))
        return 1
    if nulls > 1:
        # A unique index allows only one document without the key.
        log('%d documents have no annotationId; a unique index would fail. '
            'Inspect and remove them by hand first.' % nulls)
        return 1

    coll.drop_index(INDEX_NAME)
    log('dropped non-unique %s; building it unique' % INDEX_NAME)
    index = None
    try:
        index = buildIndexAndWait(db, unique=True)
    finally:
        if not (index and index.get('unique')):
            log('UNIQUE BUILD FAILED or was interrupted; restoring the plain '
                'index')
            try:
                restored = buildIndexAndWait(db)
            except PyMongoError as error:
                restored = None
                log('restore raised %s' % error)
            if restored:
                log('restored plain index: %s' % restored)
            else:
                log('!!! %s HAS NO %s INDEX. Every lookup by annotationId '
                    'is now a collection scan. Recreate it by hand NOW: '
                    "create_index([('annotationId', 1)])"
                    % (COLLECTION, INDEX_NAME))
    if index and index.get('unique'):
        log('done: %s' % index)
        return 0
    return 1


def main():
    parser = argparse.ArgumentParser(
        description=__doc__.split('\n\n')[0],
        formatter_class=argparse.RawDescriptionHelpFormatter)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--apply', action='store_true',
                      help='merge duplicates (default: report only)')
    mode.add_argument('--make-unique', action='store_true',
                      help='rebuild annotationId_1 as a unique index')
    parser.add_argument('--batch-size', type=int, default=2000,
                        help='annotationIds per merge batch')
    parser.add_argument('--backup-collection', default=DEFAULT_BACKUP,
                        help='where originals are copied before a merge')
    args = parser.parse_args()

    db = getDbConnection().get_default_database()
    if args.make_unique:
        return makeUnique(db)
    remaining = dedup(db, args.backup_collection, args.batch_size, args.apply)
    return 1 if args.apply and remaining else 0


if __name__ == '__main__':
    sys.exit(main())

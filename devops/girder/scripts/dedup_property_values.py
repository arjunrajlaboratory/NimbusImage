"""One-off operator tool: one annotation_property_values document per annotation.

Background (see codebaseDocumentation/PROPERTY_VALUES_UNIQUE_INDEX.md):
the pre-#1356 property-value write path raced, leaving some annotations with
two or three values documents. AnnotationPropertyValues.__init__ (PR #1347)
now enforces a UNIQUE ``annotationId_1`` index at Girder startup: it drops
a non-unique ``annotationId_1`` and rebuilds it unique. On a large
collection that rebuild outlasts the client's socket timeout in every
uvicorn worker, and with duplicates present it can never succeed -- which
left production with no annotationId index at all on 2026-10-09.

Run this BEFORE deploying a backend that contains #1347 to an install with
a large or duplicated ``annotation_property_values`` collection. Once the
index is already unique, the startup code skips the drop and its
``create_index`` is an instant no-op.

Usage (inside the running girder container, which has the DB config)::

    docker cp dedup_property_values.py girder:/tmp/
    docker exec girder python /tmp/dedup_property_values.py            # report only
    docker exec girder python /tmp/dedup_property_values.py --apply    # merge
    docker exec girder python /tmp/dedup_property_values.py --make-unique

``--apply`` merges each duplicate group into its OLDEST document: the
``values`` dicts are deep-merged and, where documents disagree on a leaf,
the NEWEST document (largest ``_id``) wins. Every document of every merged
group -- the keeper's original included -- is first copied into a backup
collection, so the merge can be reversed. Re-running is safe: an
interrupted run just finds what is left.

``--make-unique`` refuses to run while duplicates remain. It drops the
non-unique ``annotationId_1`` and builds it unique, waiting on the
server-side build past the client socket timeout. If the unique build
fails it rebuilds the plain index, so the collection is never left
without one. Lookups by annotationId are unindexed for the few minutes the
build takes (~3 min for 35M documents on an Atlas M20), so run it in a
quiet window. If your DB user may run ``collMod``, converting the index in
place (``prepareUnique`` then ``unique``) avoids that gap entirely; the
production app user could not.
"""
import argparse
import collections
import copy
import time

from pymongo import DeleteMany, ReadPreference, UpdateOne
from pymongo.errors import BulkWriteError, PyMongoError

from girder.models import getDbConnection

COLLECTION = 'annotation_property_values'
INDEX_NAME = 'annotationId_1'
INDEX_KEY = [('annotationId', 1)]
DUPLICATE_KEY_ERROR = 11000


def log(*args):
    print(time.strftime('%H:%M:%S'), *args, flush=True)


def findDuplicateIds(coll):
    """Return every annotationId that has more than one document.

    Streams the annotationId index in key order and counts adjacent
    repeats: a covered index scan (~80 s for 35M documents) with no
    server-side memory pressure, unlike a $group over the collection.
    Reads from a secondary when one is available.
    """
    secondary = coll.with_options(
        read_preference=ReadPreference.SECONDARY_PREFERRED)
    cursor = (secondary.find({}, {'annotationId': 1, '_id': 0})
              .sort('annotationId', 1)
              .hint(INDEX_NAME)
              .batch_size(20000))
    previous, run, duplicates = None, 0, []
    for document in cursor:
        annotationId = document.get('annotationId')
        if run and annotationId == previous:
            run += 1
            continue
        if run > 1:
            duplicates.append(previous)
        previous, run = annotationId, 1
    if run > 1:
        duplicates.append(previous)
    return duplicates


def mergeNewestWins(target, source):
    """Deep-merge source into target; source wins on conflicting leaves."""
    for key, value in source.items():
        if isinstance(value, dict) and isinstance(target.get(key), dict):
            mergeNewestWins(target[key], value)
        else:
            target[key] = value


def mergedValues(documents):
    """Merge a group's values, oldest to newest, without aliasing inputs."""
    merged = {}
    for document in sorted(documents, key=lambda d: d['_id']):
        mergeNewestWins(merged, copy.deepcopy(document.get('values') or {}))
    return merged


def leaves(values, prefix=''):
    if isinstance(values, dict) and values:
        for key, value in values.items():
            yield from leaves(value, prefix + '/' + key)
    else:
        yield prefix, values


def classify(documents):
    """Describe how a group's copies relate, for the dry-run report."""
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


def dedup(db, backupName, batchSize, apply):
    coll = db[COLLECTION]
    backup = db[backupName]
    start = time.time()
    duplicates = findDuplicateIds(coll)
    log('annotationIds with duplicate documents: %d (scan %.0fs)'
        % (len(duplicates), time.time() - start))
    if not duplicates:
        return 0

    stats = collections.Counter()
    batches = (len(duplicates) + batchSize - 1) // batchSize
    for batchIndex in range(batches):
        ids = duplicates[batchIndex * batchSize:(batchIndex + 1) * batchSize]
        groups = collections.defaultdict(list)
        # Primary read: merge the freshest data.
        for document in coll.find({'annotationId': {'$in': ids}}):
            groups[document['annotationId']].append(document)
        backups, operations = [], []
        for documents in groups.values():
            if len(documents) < 2:
                stats['already_single'] += 1
                continue
            documents.sort(key=lambda d: d['_id'])
            stats['groups'] += 1
            stats['size_%d' % len(documents)] += 1
            stats[classify(documents)] += 1
            keeper, extras = documents[0], documents[1:]
            stats['documents_to_delete'] += len(extras)
            backups.extend(documents)
            operations.append(UpdateOne(
                {'_id': keeper['_id']},
                {'$set': {'values': mergedValues(documents)}}))
            operations.append(DeleteMany(
                {'_id': {'$in': [d['_id'] for d in extras]}}))
        if apply and operations:
            try:
                backup.insert_many(backups, ordered=False)
            except BulkWriteError as error:
                # A re-run re-backs-up documents saved by the interrupted
                # run; those collide on _id, which is fine. Anything else
                # must stop the merge before it deletes unbacked documents.
                writeErrors = error.details.get('writeErrors') or []
                if any(e.get('code') != DUPLICATE_KEY_ERROR
                       for e in writeErrors):
                    raise
            result = coll.bulk_write(operations, ordered=True)
            stats['modified'] += result.modified_count
            stats['deleted'] += result.deleted_count
        log('batch %d/%d %s' % (batchIndex + 1, batches, dict(stats)))

    log('%s: %s in %.0fs' % (
        'merged' if apply else 'dry run, nothing written',
        dict(stats), time.time() - start))
    if not apply:
        return len(duplicates)
    remaining = findDuplicateIds(coll)
    log('annotationIds still duplicated after merge: %d' % len(remaining))
    return len(remaining)


def indexState(db):
    builds = db.command('collStats', COLLECTION).get('indexBuilds') or []
    return builds, db[COLLECTION].index_information().get(INDEX_NAME)


def waitForIndexBuilds(db):
    while indexState(db)[0]:
        time.sleep(10)


def createIndexAndWait(db, **options):
    try:
        db[COLLECTION].create_index(INDEX_KEY, name=INDEX_NAME, **options)
    except PyMongoError as error:
        # The build outlives the client's socket timeout but keeps running
        # server-side; the wait below sees it through. Real failures show
        # up as a missing index afterwards.
        log('create_index raised %s; waiting on the server-side build'
            % type(error).__name__)
    waitForIndexBuilds(db)
    return indexState(db)[1]


def makeUnique(db):
    builds, index = indexState(db)
    if builds:
        log('index builds already in progress on %s: %s; not touching it'
            % (COLLECTION, builds))
        return 1
    if index and index.get('unique'):
        log('%s is already unique; nothing to do' % INDEX_NAME)
        return 0
    remaining = findDuplicateIds(db[COLLECTION])
    if remaining:
        log('%d annotationIds still have duplicates; run --apply first'
            % len(remaining))
        return 1
    if index:
        db[COLLECTION].drop_index(INDEX_NAME)
        log('dropped non-unique %s; building it unique' % INDEX_NAME)
    index = createIndexAndWait(db, unique=True)
    if index and index.get('unique'):
        log('done: %s' % index)
        return 0
    log('UNIQUE BUILD FAILED (index now %s); restoring the plain index'
        % index)
    log('restored: %s' % createIndexAndWait(db))
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
    parser.add_argument(
        '--backup-collection',
        default='annotation_property_values_dedup_backup_%s'
        % time.strftime('%Y%m%d'),
        help='where merged-away documents are copied before deletion')
    args = parser.parse_args()

    db = getDbConnection().get_default_database()
    if args.make_unique:
        return makeUnique(db)
    remaining = dedup(db, args.backup_collection, args.batch_size, args.apply)
    return 1 if args.apply and remaining else 0


if __name__ == '__main__':
    raise SystemExit(main())

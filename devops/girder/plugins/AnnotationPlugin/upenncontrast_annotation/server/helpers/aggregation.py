"""Shared limits for the plugin's aggregation pipelines.

Lives here rather than in a model so both the annotation and property-value
models can bound their pipelines without importing each other (annotation.py
already imports propertyValues.py).
"""

import queue
import threading

import bson

# Bound any single aggregation's DB runtime so one expensive query (e.g. over a
# 700K-annotation public dataset) can't run unbounded and pin a Mongo
# connection. 5 minutes: comfortably above the slowest legitimate query, but a
# hard ceiling against a runaway one.
AGGREGATION_MAX_TIME_MS = 300000

# Raw batches a prefetch thread may hold ahead of the consumer.
PREFETCH_BATCHES = 4
# How often a blocked prefetch thread checks whether its consumer left.
_PREFETCH_POLL_SECONDS = 0.5
_END = object()


def prefetchedDocuments(rawBatches, codecOptions, depth=PREFETCH_BATCHES):
    """Documents of a raw-batch cursor, decoded in the caller while a thread
    fetches the batches ahead.

    A pymongo cursor asks for its next batch only once the current one is
    consumed, so a pipeline whose server-side work and client-side decoding
    are both large (the stubs aggregate: seconds of each at 700K) runs them
    back to back. The thread keeps up to `depth` batches in flight instead.
    Closing the generator early (a dropped response) stops the thread and
    closes the cursor; a fetch error is re-raised in the consumer.
    """
    ready = queue.Queue(maxsize=depth)
    stopped = threading.Event()

    def fetch():
        item = None
        try:
            for batch in rawBatches:
                while not stopped.is_set():
                    try:
                        ready.put(batch, timeout=_PREFETCH_POLL_SECONDS)
                        break
                    except queue.Full:
                        continue
                if stopped.is_set():
                    return
            item = _END
        except Exception as error:  # re-raised in the consumer, below
            item = error
        finally:
            try:
                rawBatches.close()
            except Exception as error:  # delivered to the consumer, below
                # A fetch error is the more useful one to report; after a
                # clean run the close error must still reach the consumer,
                # or it would wait for an end that never comes.
                if item is _END:
                    item = error
        while not stopped.is_set():
            try:
                ready.put(item, timeout=_PREFETCH_POLL_SECONDS)
                return
            except queue.Full:
                continue

    def documents():
        thread = threading.Thread(target=fetch, daemon=True)
        thread.start()
        try:
            while True:
                item = ready.get()
                if item is _END:
                    return
                if isinstance(item, Exception):
                    raise item
                yield from bson.decode_all(item, codec_options=codecOptions)
        finally:
            stopped.set()

    return documents()

"""girder.env asks for compressors=zstd. Without the zstd module pymongo
only warns and connects uncompressed, so pin that the module is there."""
import warnings

from pymongo import MongoClient


def testZstdWireCompressionIsAvailable():
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        MongoClient(
            "mongodb://localhost:27017/?compressors=zstd", connect=False
        ).close()
    # Only the missing-module warning; an unrelated deprecation shouldn't
    # fail this test.
    assert not [w for w in caught if "compression" in str(w.message)]

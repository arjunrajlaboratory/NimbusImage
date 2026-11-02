"""girder.env asks for compressors=zstd. Without the zstd module pymongo
only warns and connects uncompressed, so pin that the module is there."""
import warnings

from pymongo import MongoClient


def testZstdWireCompressionIsAvailable():
    with warnings.catch_warnings():
        warnings.simplefilter("error")
        MongoClient(
            "mongodb://localhost:27017/?compressors=zstd", connect=False
        ).close()

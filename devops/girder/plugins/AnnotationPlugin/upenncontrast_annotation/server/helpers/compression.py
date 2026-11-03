"""zstd for API responses, done by the Girder instances.

Nothing else compresses API responses: HAProxy and the static nginx pass
them through, so a 100K-annotation list is ~100 MB on the wire. Compressing
here keeps the CPU on the Girder instances (they scale out) instead of the
single load balancer, and runs in the request's worker thread rather than
the ASGI event loop.

Chrome, Edge, Firefox and Safari 26.3+ accept zstd; other clients get the
body uncompressed. There is no gzip fallback: gzip level 1 is 3-4x slower
than zstd level 1 and larger, so it slowed responses down on links faster
than ~50 MB/s, while zstd stays ahead of even a gigabit link. The body is
compressed chunk by chunk without flushing between chunks, so even the CSV
export, which streams one line per chunk, compresses as well as a whole
body would.
"""
try:
    from compression import zstd
except ImportError:  # Python < 3.14; backports.zstd (setup.py)
    from backports import zstd

import cherrypy
from cherrypy.lib import httputil, set_vary_header

# zstd level 1, the fastest positive level. On real Xenium responses it
# compressed 100K annotations 131 -> 39 MB at ~750 MB/s on one core; level 3
# was both slower and larger, and negative levels nearly doubled the size.
# Its window is 512 KB. HTTP zstd (RFC 9659) caps the window at 8 MB and
# Chrome rejects larger ones, so don't raise the level into windowLog 23+
# without also setting window_log.
ZSTD_LEVEL = 1
# Streamed responses (the big lists and exports) get two worker threads,
# which compress while the request thread keeps producing the body and
# roughly double throughput. They hold ~10 MB of job buffers while a large
# body is in flight, for as long as a slow client takes to read it, plus the
# compressed output of a chunk (all of it for an export yielded as one
# chunk). Buffered responses compress on the request thread; even a
# tens-of-MB one takes only tens of ms.
ZSTD_STREAMED_THREADS = 2

# Chosen by Content-Type: images, TIFF regions and octet-stream bodies are
# left alone. A Girder file download whose mimeType is JSON/CSV/TSV is
# compressed too; a Range request answers 206, which is not.
COMPRESSED_MIME_TYPES = [
    "application/json",
    "application/geo+json",
    "text/csv",
    "text/tab-separated-values",
]


def _acceptsZstd(request):
    # CherryPy raises a 400 for a malformed q-value, either while sorting
    # several codings or when `qvalue` is read. The handler has already run
    # (and may have written), so serve the body uncompressed instead.
    try:
        return any(
            coding.value.lower() == "zstd" and coding.qvalue > 0
            for coding in request.headers.elements("Accept-Encoding")
        )
    except cherrypy.HTTPError:
        return False


def _zstdCompress(body, threads):
    compressor = zstd.ZstdCompressor(options={
        zstd.CompressionParameter.compression_level: ZSTD_LEVEL,
        zstd.CompressionParameter.nb_workers: threads,
    })
    try:
        for chunk in body:
            yield compressor.compress(chunk)
        yield compressor.flush()
    finally:
        # CherryPy closes only the body it was handed (this generator), and
        # streaming endpoints rely on close() to stop prefetch threads and
        # close cursors when a response is dropped.
        close = getattr(body, "close", None)
        if close is not None:
            close()


def compressResponse():
    """before_finalize hook: zstd the response when the client accepts it.
    """
    request = cherrypy.serving.request
    response = cherrypy.serving.response
    set_vary_header(response, "Accept-Encoding")
    contentType = response.headers.get("Content-Type", "").split(";")[0]
    if (
        contentType not in COMPRESSED_MIME_TYPES
        or "Content-Encoding" in response.headers
        or httputil.valid_status(response.status)[0] == 206
        or not response.body
        or not _acceptsZstd(request)
    ):
        return
    response.headers["Content-Encoding"] = "zstd"
    response.body = _zstdCompress(
        response.body, ZSTD_STREAMED_THREADS if response.stream else 0
    )
    # A streamed file download presets the uncompressed length; finalize()
    # recomputes it for a buffered body.
    response.headers.pop("Content-Length", None)


def enableResponseCompression(apiRoot):
    """Compress every response under `apiRoot` (info["apiRoot"], i.e.
    /api/v1).

    CherryPy merges `_cp_config` from each object along the dispatch path,
    so setting it on the API root covers every resource under it, including
    those other plugins attach later, and both the `/api` mount and the
    `GIRDER_URL_ROOT` prefix mount, which share this object."""
    cherrypy.tools.nimbusCompress = cherrypy.Tool(
        "before_finalize", compressResponse, priority=80
    )
    apiRoot._cp_config = {
        **getattr(apiRoot, "_cp_config", {}),
        "tools.nimbusCompress.on": True,
    }

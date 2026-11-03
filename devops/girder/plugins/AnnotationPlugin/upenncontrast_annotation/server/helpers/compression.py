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
except ImportError:  # Python < 3.14; installed by pymongo[zstd]
    from backports import zstd

import cherrypy
from cherrypy.lib import encoding, httputil

# zstd level 1, the fastest positive level. On real Xenium responses it
# compressed 100K annotations 131 -> 39 MB at ~750 MB/s on one core; level 3
# was both slower and larger, and negative levels nearly doubled the size.
ZSTD_LEVEL = 1
# Two worker threads compress while the request thread keeps producing the
# body, roughly doubling throughput. They cost ~0.1 ms and a few MB per
# response, which small responses don't need but don't notice either.
ZSTD_THREADS = 2

# Text bodies only: tiles and file downloads are already compressed or
# binary, and the event stream must not be buffered by a compressor.
COMPRESSED_MIME_TYPES = [
    "application/json",
    "application/geo+json",
    "text/csv",
    "text/tab-separated-values",
]


def _acceptsZstd(request):
    return any(
        coding.value == "zstd" and coding.qvalue > 0
        for coding in request.headers.elements("Accept-Encoding")
    )


def _zstdCompress(body):
    compressor = zstd.ZstdCompressor(options={
        zstd.CompressionParameter.compression_level: ZSTD_LEVEL,
        zstd.CompressionParameter.nb_workers: ZSTD_THREADS,
    })
    for chunk in body:
        yield compressor.compress(chunk)
    yield compressor.flush()


def compressResponse():
    """before_finalize hook: zstd the response when the client accepts it.
    """
    request = cherrypy.serving.request
    response = cherrypy.serving.response
    encoding.set_vary_header(response, "Accept-Encoding")
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
    response.body = _zstdCompress(response.body)
    # finalize() recomputes it for a buffered body
    response.headers.pop("Content-Length", None)


def enableResponseCompression(apiRoot):
    """Compress every response under `apiRoot` (info["apiRoot"], i.e.
    /api/v1).

    Girder mounts the API before loading plugins, so the mounted
    application's config can't be changed here; CherryPy also reads
    `_cp_config` from each object along the dispatch path, which covers
    every resource under the root, core Girder's included."""
    cherrypy.tools.nimbusCompress = cherrypy.Tool(
        "before_finalize", compressResponse, priority=80
    )
    apiRoot._cp_config = {
        **getattr(apiRoot, "_cp_config", {}),
        "tools.nimbusCompress.on": True,
    }

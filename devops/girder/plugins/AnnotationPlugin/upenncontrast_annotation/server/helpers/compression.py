"""Gzip for API responses, done by the Girder instances.

Nothing else compresses API responses: HAProxy and the static nginx pass
them through, so a 100K-annotation list is ~100 MB on the wire. Compressing
here keeps the CPU on the Girder instances (they scale out) instead of the
single load balancer, and runs in the request's worker thread rather than
the ASGI event loop.

CherryPy's gzip tool does the encoding. It compresses a streamed body chunk
by chunk without flushing between chunks, so even the CSV export, which
streams one line per chunk, compresses as well as a whole body would.
"""
import cherrypy
from cherrypy.lib import encoding

# zlib level 1, the fastest: on real Xenium responses it compressed 100K
# annotations 137 -> 48 MB in 0.58 s, where level 3 reached 47 MB in 1.1 s
# and level 6 44 MB in 2.5 s. Stubs (6.4x), property values (5.3x) and the
# CSV export (15x) shrink more, at the same speed or faster.
GZIP_LEVEL = 1

# Text bodies only: tiles and file downloads are already compressed or
# binary, and the event stream must not be buffered by a compressor.
GZIP_MIME_TYPES = [
    "application/json",
    "application/geo+json",
    "text/csv",
    "text/tab-separated-values",
]


def _acceptsGzip(request):
    return any(
        coding.value in ("gzip", "x-gzip") and coding.qvalue > 0
        for coding in request.headers.elements("Accept-Encoding")
    )


def gzipResponse():
    """before_finalize hook: gzip the response when the client accepts it.

    CherryPy's gzip answers 406 when the client sends Accept-Encoding
    without gzip (e.g. only "br"), so it is called only when gzip is
    acceptable; otherwise the body goes out uncompressed."""
    request = cherrypy.serving.request
    response = cherrypy.serving.response
    if (
        "Content-Encoding" in response.headers
        or response.status == 206
        or not _acceptsGzip(request)
    ):
        encoding.set_vary_header(response, "Accept-Encoding")
        return
    encoding.gzip(compress_level=GZIP_LEVEL, mime_types=GZIP_MIME_TYPES)


def enableResponseCompression(apiRoot):
    """Gzip every response under `apiRoot` (info["apiRoot"], i.e. /api/v1).

    Girder mounts the API before loading plugins, so the mounted
    application's config can't be changed here; CherryPy also reads
    `_cp_config` from each object along the dispatch path, which covers
    every resource under the root, core Girder's included."""
    cherrypy.tools.nimbusGzip = cherrypy.Tool(
        "before_finalize", gzipResponse, priority=80
    )
    apiRoot._cp_config = {
        **getattr(apiRoot, "_cp_config", {}),
        "tools.nimbusGzip.on": True,
    }

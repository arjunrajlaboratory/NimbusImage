"""zstd for API responses, done by the Girder instances, on request.

Nothing else compresses API responses: HAProxy and the static nginx pass
them through, so a 100K-annotation list is ~100 MB on the wire. Compressing
here keeps the CPU on the Girder instances (they scale out) instead of the
single load balancer, and runs in the request's worker thread rather than
the ASGI event loop.

Compression is opt-in: a request is compressed only when it carries
`?compress=zstd` and its `Accept-Encoding` includes zstd. It pays off only
on links slower than Girder produces a large list (~250 MB/s locally).
Browsers and laptops are on such links: the 709K-annotation page load got
31% faster at 25 MB/s and 14% at ~110 MB/s. Workers and the MCP server
reach Girder over the AWS private network, where compressing cost 5-15%
(0.05-0.2 s per 100K annotations), the same way Girder<->MongoDB zstd made
prod reads slower (AWSDeploy #137). Their HTTP clients (urllib3 2.7 on
Python 3.14) advertise zstd on their own, so `Accept-Encoding` alone can't
tell them apart; the frontend and the nimbusimage package send the
parameter, the worker client doesn't. It is a query parameter rather than
a header because a custom header would need adding to Girder's CORS
allow-list, or every cross-origin request's preflight fails.

Chrome, Edge, Firefox and Safari 26.3+ accept zstd; other clients get the
body uncompressed. There is no gzip fallback: gzip level 1 is 3-4x slower
than zstd level 1 and larger, so it slowed responses down on links faster
than ~50 MB/s. The body is compressed chunk by chunk without flushing
between chunks, so even the CSV export, which streams one line per chunk,
compresses as well as a whole body would.
"""
from urllib.parse import parse_qsl, urlencode

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

# The query parameter (and value) that opts a request in. It is removed from
# request.params and request.query_string before the endpoint runs, so no
# endpoint sees it (the MCP OAuth endpoints refuse any query string).
OPT_IN_PARAM = "compress"
OPT_IN_VALUE = "zstd"

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


def takeCompressionOptIn():
    """before_handler hook: remove the opt-in parameter from the request and,
    when it asks for zstd, compress this response."""
    request = cherrypy.serving.request
    value = request.params.pop(OPT_IN_PARAM, None)
    if value is None:
        return
    pairs = parse_qsl(request.query_string, keep_blank_values=True)
    request.query_string = urlencode(
        [(key, item) for key, item in pairs if key != OPT_IN_PARAM]
    )
    if value == OPT_IN_VALUE:
        request.hooks.attach("before_finalize", compressResponse, priority=80)


def compressResponse():
    """before_finalize hook, attached only to opted-in requests: zstd the
    response when the client accepts it."""
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
    """Let every request under `apiRoot` (info["apiRoot"], i.e. /api/v1) opt
    in to compression.

    CherryPy merges `_cp_config` from each object along the dispatch path,
    so setting it on the API root covers every resource under it, including
    those other plugins attach later, and both the `/api` mount and the
    `GIRDER_URL_ROOT` prefix mount, which share this object."""
    # before_handler runs after the query string and any form body are in
    # request.params and before the endpoint reads them.
    cherrypy.tools.nimbusCompress = cherrypy.Tool(
        "before_handler", takeCompressionOptIn
    )
    apiRoot._cp_config = {
        **getattr(apiRoot, "_cp_config", {}),
        "tools.nimbusCompress.on": True,
    }

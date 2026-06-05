# API Rate Limiting and Batch Size Audit

## Context

The `nimbusimage` Python API makes it easy to create, delete, and modify large numbers of annotations, connections, and property values programmatically. Without safeguards, a user could inadvertently (or intentionally) swamp the server with millions of items in a single call.

This document audits the current state of protections and recommends future work.

## Current protections

| Layer | Protection | Limit | Location |
|-------|-----------|-------|----------|
| Girder (Cherrypy) | Max request body size | 1 GB | `devops/girder/girder.cfg` |
| Property values | Client-side auto-batching | 10K entries/request | `nimbusimage/properties.py`, `annotation_client/annotations.py` |
| MongoDB | Per-document size limit | 16 MB | MongoDB default |
| Memcached | Max cached tile size | 8 MB | `docker-compose.yaml` |
| Worker compute (API) | HAProxy per-user rate limit | 1 request / ~5 min | AWSDeploy `templates/startup_haproxy.tftpl` |

### Worker-request rate limiting (HAProxy)

The production load balancer (AWSDeploy repo) rate-limits worker-compute
submissions from the `nimbusimage` Python client. GPU Celery workers are
started on demand and take several minutes to spin up, so a script submitting
jobs in a tight loop can flood the queue faster than workers come online.

- **What is limited:** `POST /upenn_annotation/compute` and
  `POST /annotation_property/{id}/compute` (the endpoints that spin up GPU
  workers).
- **Who is limited:** only the `nimbusimage` Python client, identified by its
  `User-Agent: nimbusimage-python/<version>` header. The browser front-end
  (and any `Mozilla/*` agent) is never matched, even though it authenticates
  with the same `Girder-Token`. There is no HAProxy-level way to tell a
  token minted from an API key apart from a login token, so the User-Agent is
  used as the proxy signal for "programmatic API client."
- **Scope:** keyed by `Girder-Token` (per user) via an HAProxy stick-table.
- **Window:** configurable via the `WORKER_REQUEST_RATE_LIMIT_SECONDS`
  Terraform variable (default 300s, ~matching worker spin-up time).
- **Response:** HTTP 429 with a JSON body and a `Retry-After` header. The
  client surfaces this as `nimbusimage.WorkerRateLimitError` (with
  `.retry_after`).

## What's missing

### No batch size limits on bulk endpoints

These backend endpoints accept arbitrarily large arrays with no server-side limit:

| Endpoint | Method | Risk |
|----------|--------|------|
| `POST /upenn_annotation/multiple` | Create annotations | Could insert millions of documents |
| `DELETE /upenn_annotation/multiple` | Delete annotations | Could delete entire dataset in one call |
| `POST /annotation_connection/multiple` | Create connections | Same as annotations |
| `DELETE /annotation_connection/multiple` | Delete connections | Same |
| `POST /annotation_property_values/multiple` | Create property values | Client batches at 10K, but backend has no limit |

The backend calls `saveMany()` / `removeWithQuery()` directly on the MongoDB collection with no array size validation.

### Limited rate limiting

Worker-compute submissions from the Python API are now throttled at HAProxy
(see "Worker-request rate limiting" above). Beyond that, there is still no
general rate limiting in the stack:
- No per-user request throttling on read/write data endpoints
- No per-endpoint rate limits outside the worker-compute paths
- No concurrent request limits
- No nginx rate limiting (no nginx in the current docker-compose setup)
- Note: the HAProxy worker rate limit lives only in the production deployment
  (AWSDeploy), not in the local `docker-compose` dev stack.

### No per-user concurrent job limit

Worker jobs (`ds.annotations.compute()`, `ds.properties.compute()`) create Docker containers via Girder Worker. There is no limit on how many jobs a user can submit simultaneously.

## Practical constraints (implicit limits)

Even without explicit limits, these factors prevent truly unbounded abuse:

- **1 GB request body** — Cherrypy rejects requests over this size
- **Request timeouts** — Cherrypy default timeout (typically 300-600s) kills long-running requests
- **Memory pressure** — Very large requests consume server memory during JSON parsing and MongoDB insertion
- **MongoDB write performance** — `insert_many` with millions of documents will be slow but won't crash

The legacy `annotation_client` has a comment: *"Have run into trouble with 140K entries"* for property values, which led to the 10K batch size. This suggests the practical limit for a single request is somewhere between 10K and 140K items.

## Recommendations

### Server-side (backend) — where hard limits should live

These protect against all clients (Python API, frontend, curl, etc.):

1. **Add batch size validation** to bulk endpoints. Reject requests with more than N items (suggested: 50K) with HTTP 400:
   ```python
   # In annotation.py multipleCreate:
   MAX_BATCH_SIZE = 50000
   if len(bodyJson) > MAX_BATCH_SIZE:
       raise RestException(
           code=400,
           message=f"Batch size {len(bodyJson)} exceeds maximum {MAX_BATCH_SIZE}. "
                   "Submit in smaller batches."
       )
   ```

2. **Add rate limiting** via nginx or a Girder plugin. Suggested starting point:
   - 100 requests/minute per user for write endpoints (POST, PUT, DELETE)
   - 1000 requests/minute per user for read endpoints (GET)

   *Partially done:* worker-compute submissions are now rate-limited at HAProxy
   in production (see above). Extending this to general read/write endpoints is
   still open.

3. **Add concurrent job limits** — max N active worker jobs per user (suggested: 5-10).

### Client-side (nimbusimage) — convenience batching

The Python API should auto-batch large operations as a convenience, similar to how `submit_values` already does:

1. **`create_many()`** — auto-batch at 10K annotations per request
2. **`delete_many()`** — auto-batch at 10K IDs per request
3. **Connection bulk operations** — same 10K batching
4. **Progress callbacks** — for batched operations, optionally report progress

This doesn't replace server-side limits (a user could bypass the Python API), but it prevents accidental self-inflicted outages from Python scripts.

### Priority

| Action | Priority | Reason |
|--------|----------|--------|
| Server-side batch size limits | High | Prevents accidental server overload from any client |
| Client-side auto-batching | Medium | UX improvement, prevents common mistakes |
| Rate limiting | Medium | Protects shared deployments |
| Concurrent job limits | Low | Workers are naturally throttled by Docker resource limits |

## Not blocking the current PR

This is all future work. The current `nimbusimage` API is safe for normal use — the risk is primarily from scripts that accidentally generate millions of items in a loop. The 10K batching on property values is a good model to follow for the other bulk operations.

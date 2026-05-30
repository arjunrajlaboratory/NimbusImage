---
name: nimbus-local-ops
description: "Use when authenticating with the local Girder backend, making curl requests to REST API endpoints, querying MongoDB directly via docker exec, checking Docker container logs, or debugging backend issues at runtime. Covers: authentication (token retrieval), endpoint name mapping (upenn_annotation not annotation), curl templates for all plugin endpoints, direct MongoDB shell access, container management, and step-by-step test scenarios for verifying backend changes."
---

# Nimbus Local Operations

## Authentication

Get an auth token:

```bash
curl -s -u USER:PASS http://localhost:8080/api/v1/user/authentication | python3 -m json.tool
```

Default dev credentials: `admin` / `password`

Extract just the token:

```bash
TOKEN=$(curl -s -u admin:password http://localhost:8080/api/v1/user/authentication | python3 -c "import sys,json; print(json.load(sys.stdin)['authToken']['token'])")
```

Use the token in subsequent requests:

```bash
curl -s -H "Girder-Token: $TOKEN" http://localhost:8080/api/v1/upenn_annotation?datasetId=DATASET_ID
```

Tokens expire after ~6 months. Store in a shell variable for the session.

## REST API Quick Reference

**Base URL:** `http://localhost:8080/api/v1/`
**Swagger UI:** `http://localhost:8080/api/v1#!/`

### Endpoint Name Mapping

Plugin endpoints use custom names that differ from what you might expect:

| REST Path | Source File | Notes |
|-----------|-------------|-------|
| `/upenn_annotation` | `server/api/annotation.py` | NOT `/annotation` |
| `/upenn_collection` | `server/api/collection.py` | NOT `/collection` (Girder has its own) |
| `/annotation_connection` | `server/api/connections.py` | Connections between annotations |
| `/annotation_property_values` | `server/api/propertyValues.py` | Computed property data |
| `/annotation_property` | `server/api/property.py` | Property definitions |
| `/worker_interface` | `server/api/workerInterfaces.py` | Docker worker registration |
| `/worker_preview` | `server/api/workerPreviews.py` | Worker preview images |
| `/dataset_view` | `server/api/datasetView.py` | Per-user view state |
| `/history` | `server/api/history.py` | Undo/redo history |
| `/user_assetstore` | `server/api/user_assetstore.py` | Per-user storage |
| `/user_colors` | `server/api/user_colors.py` | User color preferences |
| `/export` | `server/api/export.py` | JSON/CSV export |
| `/project` | `server/api/project.py` | Project management |
| `/resource` | `server/api/resource.py` | Custom resource search |

All source files live under `devops/girder/plugins/AnnotationPlugin/upenncontrast_annotation/`.

### Basic CRUD Pattern

```bash
# List (usually requires datasetId)
curl -s -H "Girder-Token: $TOKEN" "http://localhost:8080/api/v1/upenn_annotation?datasetId=$DATASET_ID"

# Get by ID
curl -s -H "Girder-Token: $TOKEN" "http://localhost:8080/api/v1/upenn_annotation/$ID"

# Create (POST with JSON body)
curl -s -X POST -H "Girder-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"key": "value"}' "http://localhost:8080/api/v1/upenn_annotation"

# Create (POST with query params, no body)
curl -s -X POST -H "Girder-Token: $TOKEN" -H "Content-Length: 0" \
  "http://localhost:8080/api/v1/project?name=MyProject&description=Test"

# Update (PUT with JSON body)
curl -s -X PUT -H "Girder-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"key": "newValue"}' "http://localhost:8080/api/v1/upenn_annotation/$ID"

# Delete
curl -s -X DELETE -H "Girder-Token: $TOKEN" "http://localhost:8080/api/v1/upenn_annotation/$ID"
```

**Gotcha: `411 Length Required`** — Many Girder endpoints accept parameters via query string, not a JSON body (e.g., project create, share, set_public, user create). For POST/PUT without a body, you **must** add `-H "Content-Length: 0"` or CherryPy returns 411.

**Gotcha: `autoDescribeRoute` vs `describeRoute` parameter handling** — Endpoints using `autoDescribeRoute` (most project endpoints, dataset_view share/setPublic) handle parameters differently from raw `describeRoute` endpoints:

- **`autoDescribeRoute` with `.param()`**: Parameters are query string params. Use `-H "Content-Length: 0"` with query params:
  ```bash
  curl -s -X POST -H "Girder-Token: $TOKEN" -H "Content-Length: 0" \
    "http://localhost:8080/api/v1/project/$ID/set_public?public=true"
  ```

- **`autoDescribeRoute` with `.modelParam(..., paramType='formData')`**: The modelParam must be sent as form data (`-d`), NOT as a query param:
  ```bash
  # CORRECT - form data for formData modelParam
  curl -s -X POST -H "Girder-Token: $TOKEN" \
    -d "datasetId=$DATASET_ID" \
    "http://localhost:8080/api/v1/project/$ID/dataset"

  # WRONG - query param with Content-Length: 0 gives "No matching route"
  curl -s -X POST -H "Girder-Token: $TOKEN" -H "Content-Length: 0" \
    "http://localhost:8080/api/v1/project/$ID/dataset?datasetId=$DATASET_ID"
  ```

- **`describeRoute` with `.param(..., paramType='body')`**: Parameters are in a JSON body:
  ```bash
  curl -s -X POST -H "Girder-Token: $TOKEN" -H "Content-Type: application/json" \
    -d '{"key": "value"}' "http://localhost:8080/api/v1/endpoint"
  ```

**Rule of thumb**: Check the endpoint source code for `paramType`. If `formData`, use `-d "key=value"`. If `body`, use `-d '{"key": "value"}'` with `Content-Type: application/json`. If just `.param()` with no paramType, use query string with `-H "Content-Length: 0"`.

**Gotcha: Shell variable expansion in URLs** — When using shell variables in URLs, avoid `${VAR}/path` patterns inside double quotes as they can cause unexpected behavior. Use explicit concatenation or ensure proper quoting:
```bash
# Safe - variable is cleanly delimited
curl -s "http://localhost:8080/api/v1/project/${PROJECT_ID}/access"

# Also safe - separate variable
URL="http://localhost:8080/api/v1/project/$PROJECT_ID/access"
curl -s "$URL"
```

**Gotcha: Finding datasets** — Datasets are Girder folders with `meta.subtype: 'contrastDataset'`. They may be owned by any user, so listing a specific user's folders won't find all datasets. Use MongoDB directly for discovery:
```bash
docker exec upenncontrast-mongodb-1 mongosh girder --eval \
  "db.folder.find({'meta.subtype': 'contrastDataset'}, {name: 1}).limit(5).toArray()" --quiet
```

For full endpoint details with request/response examples: read `references/api-endpoints.md`

## Direct MongoDB Access

Connect to MongoDB inside the Docker container:

```bash
docker exec upenncontrast-mongodb-1 mongosh girder --eval "QUERY" --quiet
```

### Collection-to-Resource Mapping

| MongoDB Collection | Plugin Resource | Model |
|-------------------|-----------------|-------|
| `upenn_annotation` | Annotations | `Annotation` |
| `folder` | Datasets | Girder `Folder` |
| `upenn_collection` | Configurations | `Collection` |
| `annotation_connection` | Connections | `AnnotationConnection` |
| `dataset_view` | Dataset Views | `DatasetView` |
| `annotation_property` | Property Definitions | `AnnotationProperty` |
| `annotation_property_values` | Property Values | `AnnotationPropertyValues` |
| `upenn_project` | Projects | `Project` |
| `job` | Worker Jobs | Girder `Job` |

### Quick Inspection

```bash
# Count annotations
docker exec upenncontrast-mongodb-1 mongosh girder --eval "db.upenn_annotation.countDocuments()" --quiet

# Count annotations in a dataset
docker exec upenncontrast-mongodb-1 mongosh girder --eval "db.upenn_annotation.countDocuments({datasetId: ObjectId('DATASET_ID')})" --quiet

# List all datasets (folders with contrastDataset subtype)
docker exec upenncontrast-mongodb-1 mongosh girder --eval "db.folder.find({'meta.subtype': 'contrastDataset'}, {name: 1}).toArray()" --quiet

# List collections
docker exec upenncontrast-mongodb-1 mongosh girder --eval "db.getCollectionNames()" --quiet
```

For detailed query recipes: read `references/mongo-recipes.md`

## Docker Operations

### Container Names

| Container | Service | Purpose |
|-----------|---------|---------|
| `girder` | Girder API server (Girder 5, uvicorn/ASGI) | Backend REST API + notification WebSocket |
| `nimbusimage-mongodb-1` | MongoDB | Database |
| `worker` | Girder Worker | Background computation |
| `nimbusimage-broker-1` | RabbitMQ | Message broker for workers |
| `nimbusimage-redis-1` | Redis | Notification pub/sub + large_image tile cache |

**Note:** `girder` and `worker` have fixed `container_name`s, but `mongodb`, `redis`, and `broker` are prefixed with the Docker Compose project name (`nimbusimage`, derived from the repo directory). If your prefix differs, run `docker ps` to get the real names. Girder 5 replaced the old `memcached` caching container with `redis`.

### Common Commands

```bash
# View logs (last 50 lines)
docker logs girder --tail 50

# Follow logs in real-time
docker logs girder -f

# Restart a service
docker compose restart girder

# Rebuild and restart
docker compose build girder && docker compose up -d girder

# Check container status
docker ps
```

The `docker-compose.yaml` is at the repository root.

## Debugging

### Girder Logs

```bash
# Check for recent errors
docker logs girder --tail 100 2>&1 | grep -i error

# Watch for specific endpoint activity
docker logs girder -f 2>&1 | grep "upenn_annotation"
```

### Worker Job Status

```bash
# Check recent jobs
docker exec upenncontrast-mongodb-1 mongosh girder --eval "db.job.find({}, {title: 1, status: 1, updated: 1}).sort({updated: -1}).limit(5).toArray()" --quiet
```

Job status codes: 0=inactive, 1=queued, 2=running, 3=success, 4=error, 5=cancelled

### Notifications / Progress (Girder 5 WebSocket + Redis pub/sub)

Girder 5 replaced the old SSE notification stream with a WebSocket plus Redis
pub/sub. The chain for job progress / completion is:

1. Worker `PUT /api/v1/job/<id>` updates the job.
2. Girder's job model publishes `job_created` / `job_status` / `job_log` /
   progress notifications to the Redis channel `user_<userId>` via
   `girder.notification.Notification.flush()`.
3. The browser opens a WebSocket at `ws://localhost:8080/notifications/me?token=<token>`.
   Server side (`girder/notification.py` `UserNotificationsSocket`) subscribes to
   `user_<userId>` and forwards each Redis message to the socket.
4. Frontend `src/store/jobs.ts` parses frames (`data.data._id`, `.status`, `.text`)
   and resolves the job / updates the progress bar.

The frontend token now lives in `localStorage['nimbus.girderToken']` (not a cookie).

**Symptom: a job runs forever in the UI with no progress, but the job actually
completes.** That means the job/publish side works but forwarding to the browser
is broken. Bisect publish vs. forward:

```bash
# 1. Watch what Girder publishes to Redis (run while triggering a job in the UI)
docker exec nimbusimage-redis-1 redis-cli PSUBSCRIBE 'user_*'
#    -> if job_created/job_status/job_log lines appear, PUBLISH works.

# 2. Check whether the WebSocket actually subscribed on the server side.
#    With a dataset open (notification WS OPEN in the browser), this should be >=1:
docker exec nimbusimage-redis-1 redis-cli PUBSUB NUMSUB user_<userId>
docker exec nimbusimage-redis-1 redis-cli PUBSUB CHANNELS
#    -> 0 subscribers / empty channels while a socket is open == forwarding is broken
#       (server subscribed to nobody, so published events go nowhere).
```

In-browser checks (DevTools console): the app's socket is
`$store.state.jobs.notificationSource` (check `.readyState`; 1 == OPEN). A socket
can be client-side OPEN while the server has silently stopped forwarding — the
frontend gets no `onerror`/`onclose`, so it waits forever.

**Confirmed bug (girder 5.0.9 + redis-py 8.0.0):** `girder/notification.py`
`UserNotificationsSocket.listen_and_forward` iterates `self.pubsub.listen()`.
redis-py 8.0.0 changed the async `Connection` default `socket_timeout` from
`None` to **5 seconds** (verify: `Connection().socket_timeout == 5`), so an idle
pubsub read raises `redis.exceptions.TimeoutError: Timeout reading from redis:6379`
~5s after the last message. That exception is **not** `asyncio.CancelledError`,
so it bypasses the loop's only `except` and falls into the `finally`, which calls
`unsubscribe()`/`close()` — permanently tearing down the subscription. The
WebSocket stays client-side OPEN (the frontend gets no error/close event), now
subscribed to nothing, so every later notification is silently dropped → jobs
appear to run forever. Each connection works only until its first >5s idle gap,
which in practice is right after opening a dataset (before any job is run).
`docker compose restart girder` only buys ~5s for the next fresh connection.
Fix belongs upstream in girder (tolerate the timeout / re-subscribe instead of
tearing down); it also calls the deprecated `pubsub.close()` (redis-py wants
`aclose()`).

### Common Issues

- **401 Unauthorized**: Token expired or missing. Re-authenticate.
- **400 Bad Request**: Check JSON body format. Use Swagger UI to see expected schema.
- **404 Not Found**: Verify endpoint name (e.g., `upenn_annotation` not `annotation`).
- **411 Length Required**: POST/PUT without a body needs `-H "Content-Length: 0"`.
- **Connection refused**: Check `docker ps` to confirm containers are running.

For step-by-step test scenarios: read `references/test-scenarios.md`

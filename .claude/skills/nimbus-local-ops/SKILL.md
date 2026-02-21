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
| `girder` | Girder API server | Backend REST API |
| `upenncontrast-mongodb-1` | MongoDB | Database |
| `worker` | Girder Worker | Background computation |
| `upenncontrast-broker-1` | RabbitMQ | Message broker for workers |
| `upenncontrast-memcached-1` | Memcached | Caching layer |

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

### Common Issues

- **401 Unauthorized**: Token expired or missing. Re-authenticate.
- **400 Bad Request**: Check JSON body format. Use Swagger UI to see expected schema.
- **404 Not Found**: Verify endpoint name (e.g., `upenn_annotation` not `annotation`).
- **411 Length Required**: POST/PUT without a body needs `-H "Content-Length: 0"`.
- **Connection refused**: Check `docker ps` to confirm containers are running.

For step-by-step test scenarios: read `references/test-scenarios.md`

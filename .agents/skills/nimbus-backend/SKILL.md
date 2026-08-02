---
name: nimbus-backend
description: "Use when writing or modifying Python code in the Girder backend plugin (devops/girder/plugins/AnnotationPlugin/), creating REST API endpoints, writing database queries with MongoDB, implementing access control and sharing, running backend tests with tox/pytest, or debugging Docker compose services. Covers: API vs model layer separation (API raises RestException, models raise ValueError — never mix these), API endpoint patterns (@autoDescribeRoute, modelParam), access control (AccessType, setUserAccess, setPublic, permission escalation risks), database queries (Model.find not collection.find, batch $in queries not loops), model loading (exc=True not manual null checks), error handling (catch specific exceptions, never except Exception), public endpoint input validation (inline isinstance guards → RestException 400, MAX_* clamps, bson InvalidId → 400), loading plugin changes into the running container (rebuild, not restart), and backend test patterns. Use this skill even for small backend changes."
---

# Nimbus Backend Development (Girder)

## Access Control

### Access Levels (Document-Level)

| Value | Constant | Meaning |
|-------|----------|---------|
| -1 | (none) | No access / Remove access |
| 0 | `AccessType.READ` | View-only access |
| 1 | `AccessType.WRITE` | Edit access |
| 2 | `AccessType.ADMIN` | Owner — can manage access (share, set public, delete) |

**Important:** `AccessType.ADMIN` means **owner of that document**, not a site-wide admin. The creator of a project/dataset gets ADMIN on it and can share it with others.

Use `-1` (not `null`) to remove a user's access.

### Access Decorators (Endpoint-Level)

```python
from girder.api import access

@access.public      # Anyone can access
@access.user        # Requires authenticated user
@access.admin       # Requires site-wide Girder admin (NOT document owner)
```

**Note:** `@access.admin` (decorator) and `AccessType.ADMIN` (document level) are different. The decorator requires site-wide admin; the access level means document owner.

### Model-Level Access

```python
from girder.constants import AccessType

doc = Model().load(id, user=user, level=AccessType.WRITE, exc=True)
doc = Model().load(id, force=True)  # Admin bypass
```

For detailed access patterns including sharing: read `references/access-control-patterns.md`
When modifying sharing/access code: read `codebaseDocumentation/SHARING.md`

## Model Parameters: Security

### modelParam vs param

Always use `modelParam` when accepting IDs that reference resources requiring access control:

```python
# Good - validates existence AND checks WRITE access
.modelParam('datasetId', model=Folder, level=AccessType.WRITE,
            destName='dataset', paramType='formData')

# Bad - no validation, no access check
.param('datasetId', 'Dataset ID to add.', paramType='formData')
```

Use `.param()` only for simple string/number values, enums, or search filters.

### Plugin Models vs Girder Built-in Models

| Resource | Plugin Model | NOT Girder's |
|----------|--------------|--------------|
| Datasets | `Folder` (Girder) | - |
| Collections/Configs | `Collection` (plugin) | `Item` |
| Projects | `Project` (plugin) | - |
| Annotations | `Annotation` (plugin) | - |
| Dataset Views | `DatasetView` (plugin) | - |

```python
# Good - uses plugin's Collection model
from upenncontrast_annotation.server.models.collection import Collection
.modelParam('collectionId', model=Collection, level=AccessType.WRITE, ...)

# Bad - Girder's Item model won't find plugin collections!
from girder.models.item import Item
.modelParam('collectionId', model=Item, level=AccessType.WRITE, ...)
```

## Database Queries

**Always use `Model().find()`**, never `Model().collection.find()`:

```python
docs = list(MyModel().find({'_id': {'$in': list(ids)}}))

# With field projection
users = list(User().find(
    {'_id': {'$in': userIds}},
    fields=['email', 'login']
))
```

For detailed query patterns: read `references/database-query-patterns.md`

## API Endpoint Patterns

### Route Registration

```python
class MyResource(Resource):
    def __init__(self):
        super().__init__()
        self.resourceName = "my_resource"
        self.route("GET", (":id",), self.get)
        self.route("POST", (), self.create)
        self.route("PUT", (":id",), self.update)
        self.route("DELETE", (":id",), self.delete)
        self.route("GET", (), self.find)
```

### Auto-Describe Routes

```python
@access.user
@autoDescribeRoute(
    Description("Create a new thing")
    .notes("Detailed explanation.")
    .jsonParam("body", "Request body", paramType="body",
               schema={...}, required=True)
    .errorResponse("ID was invalid.")
    .errorResponse("Write access denied.", 403)
)
def create(self, body):
    ...
```

### Bulk Operations

```python
@access.user
@autoDescribeRoute(
    Description("Bulk create items (READ OPERATION via POST)")
    .notes("Uses POST to avoid URL length limits")
    .jsonParam("body", "Array of items", paramType="body")
)
def createBulk(self, body):
    items = body.get('items', [])
    return [self._model.create(item) for item in items]
```

### Reading the Request Body (and when @memoizeBodyJson applies)

For an endpoint that just needs the JSON body, use a plain signature and
call `getBodyJson()` directly (pattern: `datasetView.py::create`):

```python
@describeRoute(
    Description("...").param("body", "...", paramType="body")
)
def create(self, params):
    doc = self.getBodyJson()
```

Do NOT write `def handler(self, params, *args, **kwargs)` +
`@memoizeBodyJson` + `kwargs["memoizedBodyJson"]` for such endpoints.
`@memoizeBodyJson` exists for exactly one case: the endpoint is also
`@recordable` **and** its `findDatasetIdFn` needs the body (so the body
is parsed once and shared between the decorator and the handler). If the
`@recordable` finder reads the loaded model instead (e.g.
`getDatasetIdFromLoadedAnnotation`), or there is no `@recordable`,
memoizing is pointless — reviewers flag it (Paul, PR #1203).

### Girder Models Are Cached Singletons

`Model()` construction returns a cached instance (`_ModelSingleton`
metaclass in girder's model_base). Never hand-roll lazy caching
(`getattr(self, "_cache", None)` properties) around a model — just
assign it in `__init__`:

```python
self._pvModel = AnnotationPropertyValues()  # cheap: cached singleton
```

### Class Constants and Aggregation Readability

- Put class-level constants (allowed-field sets, collection names,
  `MAX_*`) at the **top of the class definition**, not between methods.
- Name `$count` aggregation output fields `count` (not `n`) so pipeline
  results are self-describing when debugging.
- Comment dense `$addFields`/`$cond`/`$ifNull` stages with what the
  stage computes and why (e.g. "$ifNull maps missing → null so one
  $ne-null test catches absent and null").

## ObjectId Handling

```python
from bson import ObjectId

query = {'_id': ObjectId(string_id)}
query = {'_id': {'$in': [ObjectId(id) for id in string_ids]}}
```

Note: `Model().load()` handles ObjectId conversion internally.

## API vs Model Layer Separation

The API and model layers have strict responsibilities. Never mix them.

### API Layer (`server/api/*.py`)
- Parses and validates input from HTTP requests
- Converts input types (string → ObjectId, JSON → dict) **once at the top of the method**
- Raises `RestException` for HTTP error responses
- Calls model methods with clean, validated data

### Model Layer (`server/models/*.py`)
- Contains business logic and data operations
- Raises `ValueError` or `ValidationException` — **never `RestException`**
- Must be abstract from HTTP/API concerns
- Should not know about request parameters or HTTP status codes

```python
# Good - API handles input, model handles logic
# In server/api/annotation.py
def update(self, annotation, body):
    tag_ids = [ObjectId(t) for t in body.get('tags', [])]
    return AnnotationModel().updateTags(annotation, tag_ids)

# In server/models/annotation.py
def updateTags(self, annotation, tag_ids):
    if not tag_ids:
        raise ValueError("At least one tag required")
    # ... business logic
```

```python
# Bad - model raising HTTP exceptions
# In server/models/annotation.py
def updateTags(self, annotation, body):
    if 'tags' not in body:
        raise RestException("tags required", 400)  # WRONG - HTTP in model
```

## Error Handling

```python
from girder.exceptions import (
    RestException, ValidationException, AccessException
)

# API layer - HTTP errors
raise RestException("Bad request message", code=400)

# Model layer - domain errors
raise ValidationException("Field X is invalid")
raise ValueError("Invalid state")

# Either layer - access errors
raise AccessException("Permission denied")
```

### Exception Handling Rules
- **Never** use `except Exception:` or bare `except:` — too broad, swallows system errors
- Catch **specific** exception types only (e.g., `except bson.errors.InvalidId:`)
- Don't add validation that duplicates framework behavior (e.g., checking ObjectId validity before `ObjectId()` conversion)

### bson InvalidId is NOT a ValueError

`bson.errors.InvalidId`'s MRO is `InvalidId → BSONError → Exception` — **`except ValueError` does not catch it**. `ObjectId("notanobjectid")` raises `InvalidId`; `ObjectId(123)` raises `TypeError`. When mapping malformed caller-supplied ids to a clean 400, catch `InvalidId` explicitly at the API boundary:

```python
from bson.errors import InvalidId

try:
    obj_ids = [ObjectId(s) for s in raw_ids]
except InvalidId:
    raise RestException("Invalid annotation id", 400)
```

Convert ids once at the API boundary and pass ObjectIds down — don't convert deep in a model/aggregation where the failure surfaces as a 500.

## Public Endpoint Input Validation

This is the single most-recurring review finding in this plugin: an endpoint calls `.get()` / `len()` / `int()` / indexes request data **without first checking its type**, so a malformed payload (JSON-array body, `filters.tags: "bad"`, scalar `annotationIds`, non-string `datasetId`, oversized `limit`) raises an uncaught `AttributeError`/`TypeError` → 500 instead of a clean 400 — and unbounded limits let callers force huge DB/serialization work. Applies to `@access.user` endpoints too, not only `@access.public`: 400-not-500 is the house style regardless of auth.

**Use the shared validators in `server/helpers/validation.py`** (added by PR #1203). Do NOT hand-roll inline `isinstance` guards for new/edited endpoints — call the helpers, which raise `RestException(code=400)` at the boundary. Real example, `server/api/dataImport.py::importData`:

```python
from ..helpers.validation import (
    requireObjectBody, requireList, requireObjectId,
)

body = requireObjectBody(kwargs["memoizedBodyJson"])
datasetId = requireObjectId(body.get("datasetId"), "datasetId")
annotations = requireList(body.get("annotations", []), "annotations")
propertyValues = requireObjectBody(body.get("propertyValues", {}), "propertyValues")
```

Match each kind of request-data access to its helper:

| Access to guard | Helper |
|---|---|
| `.get()` on a body / nested object | `requireObjectBody(value, name)` → dict-or-400 |
| `len()` / iteration on a field | `requireList(value, field)` → list-or-400 |
| `ObjectId(id)` on caller-supplied ids | `requireObjectId(value, field)` → ObjectId-or-400 (handles None, `InvalidId`, AND non-string `TypeError`) |
| `int(param)` on a query param | `requireInt(value, field)` → int-or-400 |
| unbounded counts | `requireCountWithin(count, limit, name)` / module-level `MAX_*` consts (`MAX_ANNOTATION_IDS`, `MAX_LIST_LIMIT`, ...) read at call time (monkeypatchable in tests) |
| filter / sort / propertyPaths shape | `validateListInputs(...)`, `validatePropertyPaths(...)`, `validateUncomputedCountsProperties(...)` |

`requireObjectId` catches `TypeError` as well as `InvalidId` — a non-string id like `{"datasetId": 123}` is a clean 400, not a 500 (see the bson section above).

Rules: validation and `RestException` live in the API layer, never in models. Validate NESTED elements, not just the top-level container — each list entry (`[123]`) and nested map (`propertyValues: {"a1": 5}`) is caller-supplied; `.get()`/`.items()` on a non-dict entry → 500. Add a backend test per malformed-input case (malformed body → 400, not 500); `test/test_validation.py` unit-tests the helpers directly, and endpoint tests assert the 400. When you fix one endpoint, sweep the other endpoints in the same file for the identical gap — reviewers flag one instance per round.

## Loading Plugin Changes Into the Running Backend

The `girder` container bakes the plugin into its image (no source mount). After editing backend plugin code:

- `docker compose restart girder` does **NOT** load the change — new routes return `No matching route` while old ones work.
- Required: `docker compose build girder && docker compose up -d girder` (fast — cached layers; girder is back in ~7s).
- `tox` runs against plugin **source**, so tests pass even when the live `:8080` API is stale. Always rebuild before verifying endpoints with curl or the browser.

## Logging

```python
import logging

logger = logging.getLogger(__name__)

logprint.info("Informational message")
logprint.warning("Warning message")
logprint.error(f"Error: {details}")
```

## Girder Jobs

### Job Status Constants

```python
from girder_jobs.constants import JobStatus

# JobStatus values:
# INACTIVE = 0  (not yet scheduled)
# QUEUED   = 1  (waiting to run)
# RUNNING  = 2  (currently executing)
# SUCCESS  = 3  (completed successfully)
# ERROR    = 4  (failed)
# CANCELED = 5  (cancelled)
```

**Warning:** Status 3 means **SUCCESS**, not "running". This is a common source of confusion.

Frontend equivalent: `src/store/jobConstants.ts` (`jobStates.success === 3`).

### Local Jobs (In-Process)

For tasks that run inside the Girder process (not via Girder Worker/Celery), use `createLocalJob`. The target module must define a `run(job)` function.

```python
from girder_jobs.models.job import Job as JobModel

job = JobModel().createLocalJob(
    module='upenncontrast_annotation.server.helpers.zenodo_job',
    title='My Job',
    type='my_job_type',
    user=user,
    kwargs={'projectId': str(project['_id'])},
    asynchronous=True,
)
JobModel().scheduleJob(job)
```

### Progress Reporting via SSE

Jobs report progress through `Job().updateJob()` which emits SSE events:

```python
from girder_jobs.models.job import Job

job_model = Job()
job_model.updateJob(
    job,
    status=JobStatus.RUNNING,
    log='Progress message\n',  # Sent via SSE
)
# Terminal state:
job_model.updateJob(job, status=JobStatus.SUCCESS)
```

The frontend subscribes to job SSE events via `src/store/jobs.ts`. Log entries can be JSON strings for structured progress data.

## Testing

For detailed testing patterns beyond basics: read `references/testing-patterns.md`

Testing basics (running tox, test structure, linting): see `CLAUDE.md`

## Codebase Documentation References

- When modifying sharing/access code: read `codebaseDocumentation/SHARING.md`
- When modifying project backend code: read `codebaseDocumentation/PROJECTS.md`

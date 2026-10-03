---
name: nimbus-backend
description: "Use when writing or modifying Python code in the Girder backend plugin (devops/girder/plugins/AnnotationPlugin/), creating REST API endpoints, writing database queries with MongoDB, implementing access control and sharing, running backend tests with tox/pytest, or debugging Docker compose services. Covers: API vs model layer separation (API raises RestException, models raise ValueError — never mix these), API endpoint patterns (@autoDescribeRoute, modelParam), access control (AccessType, setUserAccess, setPublic, permission escalation risks), database queries (Model.find not collection.find, batch $in queries not loops), model loading (exc=True not manual null checks), error handling (catch specific exceptions, never except Exception), public endpoint input validation (the shared server/helpers/validation.py helpers → RestException 400, never hand-rolled isinstance guards; MAX_* clamps traced for -1/0/MAX+1; sort-key allowlists; bson InvalidId → 400), loading plugin changes into the running container (rebuild, not restart), and backend test patterns (no wall-clock-dependent ordering; clamp tests must be able to fail). Use this skill even for small backend changes."
---

# Nimbus Backend Development (Girder)

## Access Control

### Access Levels (Document-Level)

| Value | Constant | Meaning |
|-------|----------|---------|
| -1 | (none) | No access / Remove access |
| 0 | `AccessType.READ` | View-only access |
| 1 | `AccessType.WRITE` | Edit access — **and delete, for item-like resources** |
| 2 | `AccessType.ADMIN` | Owner — manage access (share, set public), delete a container |

**Important:** `AccessType.ADMIN` means **owner of that document**, not a site-wide admin. The creator of a project/dataset gets ADMIN on it and can share it with others.

**Do not conclude that deleting requires ADMIN.** Reading "ADMIN … delete" off this table and flagging a `WRITE`-level delete is a false positive — it happened auditing PR #1278. The convention follows Girder core, where `DELETE /item` is `WRITE` while `DELETE /folder` is `ADMIN`:

| Resource | Delete level | Why |
|---|---|---|
| `upenn_annotation`, `annotation_connection`, `annotation_property`, `dataset_view`, `upenn_collection` | `WRITE` | item-like, lives inside a folder |
| `upenn_project` | `ADMIN` | container that owns datasets and collections |
| `project/:id/dataset/:id`, `project/:id/collection/:id` | `WRITE` | removing a child, not deleting the container |

Before changing a level, grep the sibling endpoints — `grep -n "def delete" -B 14 server/api/*.py | grep -E "@access|AccessType"` — and match them. Changing WRITE to ADMIN is a **behavior change** that stops collaborators from deleting, not a hardening no-op.

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

**Exception: anything evaluated once at import.** A decorator's
`__init__`, a module-level global or a class attribute runs once, at
import, and keeps that instance forever. In production that's harmless,
but the test suite resets every singleton between tests, so the cached
instance goes stale: `@recordable` used to hold the first test's
`HistoryModel()` and only worked because of a quadratic setup leak (see
`codebaseDocumentation/BACKEND_CI_PERFORMANCE.md`). In import-time code,
call `Model()` at the point of use instead.

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

### `autoDescribeRoute` + `pagingParams` does NOT validate for you

Everything above is written around **body**-parsing endpoints (`describeRoute` + `getBodyJson()` + `requireObjectBody`). That framing is a trap: on an `autoDescribeRoute` endpoint with `.param()` / `.pagingParams()`, Girder declares param types and coerces some of them, which *feels* like the boundary is covered. It isn't, and this shipped a P1 (PR #1278) even though the helpers above were already documented. What Girder actually does:

| Declared | Girder's behavior | Still your job |
|---|---|---|
| `.param('folderId', ...)` (no dataType) | passes the raw **string** through | `requireObjectId` — `ObjectId('nope')` raises `InvalidId` → 500 |
| `.pagingParams(...)` → `limit`, `offset` | `_handleInt` → clean `RestException` on non-numeric | **negatives pass straight through** — clamp them |
| `.pagingParams(...)` → `sort` | passes any field name through as `[(field, dir)]` | restrict to an allowlist (see below) |
| `.jsonParam(..., requireObject=True)` | 400 if the body isn't a dict/array | nested elements inside it |

So the clamp idiom is required even when the params look framework-managed:

```python
offset = max(0, offset)                       # a negative offset makes PyMongo raise
limit = min(max(1, limit or MAX_X_LIMIT), MAX_X_LIMIT)
```

### `limit + 1` for `hasMore` interacts with Girder's limit=0 sentinel

Reading one extra row to compute `hasMore` avoids a second count query, but `limit=0` means **unlimited** to Girder. So an unclamped negative limit becomes a total bypass of the cap, not merely a wrong page size:

```python
# BAD: limit=-1 -> min(-1, MAX) == -1 -> limit+1 == 0 -> Girder "unlimited"
# -> materializes EVERY accessible document, returns all but the last via
# documents[:-1]. The MAX_* cap is gone, on a public endpoint.
limit = min(limit or MAX_X_LIMIT, MAX_X_LIMIT)

# GOOD: every input lands in [1, MAX_X_LIMIT], so limit+1 is never 0
limit = min(max(1, limit or MAX_X_LIMIT), MAX_X_LIMIT)
```

Whenever you write `limit + 1` (or any arithmetic on a limit), trace the value for **`-1`, `0`, and `MAX+1`** by hand. `-1` is the dangerous one and the easiest to skip: `0` and `MAX+1` both behave, so a spot-check of "does a MAX_ constant exist" passes while the bypass sits there. Regression-test `limit=-1` specifically, asserting a clamped page — not just "no 500".

### An endpoint that hand-builds its response has no `@filtermodel` — filter it yourself

`@filtermodel` is what strips keys the model does not expose at the caller's access level. An endpoint that returns something other than a bare model document — a map keyed by id, a multi-type envelope, a computed summary — cannot use the decorator, and it is easy to miss that **nothing else is filtering**. `findWithPermissions` decides *which documents* you may see; it says nothing about *which fields*.

`POST /resource/batch` shipped that way and leaked, to any signed-in caller (found auditing PR #1278):

| Type | Leaked | Because |
|---|---|---|
| `folder` | `access` | who holds READ/WRITE/ADMIN, by user and group |
| `user` | **`salt`** (the bcrypt password hash), `email`, `groups`, `status` | User exposes only `_id/admin/created/firstName/lastName/login/public` at READ |

The fix is to call the same thing the decorator calls:

```python
mapping[str(doc['_id'])] = model.filter(doc, user)
```

**A field projection interacts with this — order matters.** `filter()` calls `getAccessLevel(doc, user)`, which reads the document's own `access` and `public`. Project those away and every document looks unreadable, silently stripping fields the caller *is* entitled to. So fetch them and drop them afterwards:

```python
fields=list(set(requested) | {'_id', 'access', 'public'})   # for the query
...
narrowed = {k: v for k, v in model.filter(doc, user).items() if k in requested}
```

Filter **then** narrow — never narrow then filter, or `fields: ["salt"]` becomes an exfiltration primitive. Regression-test exactly that: request an unexposed key explicitly and assert you get only `_id` back.

Check exposure levels rather than guessing — `email` sits at ADMIN, not READ:

```python
docker compose exec -T girder python -c "
from girder.models.user import User
u=User(); print({lvl: sorted(k) for lvl, k in u._filterKeys.items()})"
```

Expect frontend fallout when you fix one of these: the UI may have been rendering data it should never have had. Here three call sites interpolated `user.email` and two produced `"Name (undefined)"` once it was correctly withheld.

### Offset paging needs a TOTAL order — append `_id`

A `limit`/`offset` endpoint is only coherent if the sort is deterministic. Mongo stores datetimes at **millisecond** resolution, so any bulk operation stamps many documents with the same `updated`/`created`; tied documents have no defined order, and a page-2 request can then repeat a row from page 1 or skip one entirely **with the data unchanged**. Nothing errors, and it is invisible in a single-page test.

```python
# The endpoint's sort allowlist runs first, then the tie-breaker is appended.
sort = withIdTieBreaker(requireSortableFields(sort))
```

`_id` is unique, so appending it makes the order total; give it the primary key's direction so ties read the same way as the sorted column. Then put `_id` in the index — `([('updated', -1), ('_id', -1)], {})` — and drop the now-redundant single-field index, since an index whose *prefix* is `updated` still serves a plain `updated` sort.

To write a test that can actually fail: ObjectIds are monotonic, so create A then B and give both the same timestamp. `_id` descending expects **B first**, the opposite of insertion order — which is what Mongo returns without the tie-breaker (verified: the assertion fails with `'collection_first' != 'collection_second'`). Then page one row at a time and assert the union has no duplicates.

### Sort keys are caller input too

`pagingParams` exposes `sort` as a free-form field name. Clamping `limit` while leaving `sort` open still lets an unauthenticated caller force a blocking sort over every accessible document — including on a large `meta` subdocument. This is especially easy to miss right after adding an index for the *default* sort: the index covers `?sort=updated` and nothing else.

```python
for field, _direction in sort or []:
    if field not in X_SUMMARY_FIELDS:
        raise RestException(
            'sort must be one of: %s' % ', '.join(X_SUMMARY_FIELDS), code=400)
```

Restricting the allowlist to the fields the endpoint actually returns is usually the right scope, and turns a typo into a clean 400.

**`assertStatus(resp, 400)` alone is not a regression test for input validation.** These endpoints have *other* 400 paths — a missing `datasetId`, an unknown dataset id, a failed schema validation — so a malformed-body test can pass while the body is never validated at all. Observed for real: a `/upenn_annotation/compute` test using a syntactically valid but nonexistent `datasetId` passed **before** its fix, because the model's dataset lookup rejected the request first.

Two habits close it:
- **Assert the message, not just the status** (`assert "must be a JSON object" in resp.json["message"]`), and set up the request so the code actually reaches the validation — use a real `utilities.createFolder(...)` dataset when the handler looks one up before touching the body.
- **`git stash push <source files>` and confirm the test fails**, leaving the new test file in place (untracked files aren't stashed). A malformed-input test that passes both ways is worse than none.

## Resource Bounds on Public Endpoints (validate the DIMENSIONS, not just the shape)

Shape validation stops 500s. It does **not** stop one valid request from
exhausting the process. PR #1302 took **three consecutive review rounds**
finding instances of this one class, so check it deliberately.

For every public endpoint, enumerate the dimensions that **multiply**, and
bound each one — plus their product where the product is what costs:

| dimension | why a per-item cap is not enough |
|---|---|
| items × per-item work | 100 plots × a full-dataset coordinate build = ~130 s of CPU from one request |
| a product cap alone | a 512×512 cell budget still allows **one** axis with 262,144 categories when the other collapses to 1 bin |
| inner-loop length × collection size | `points_in_polygon` does one full-length numpy pass PER VERTEX: 10,000 vertices × 708K points ≈ 10 s per gate, and **no DB timeout covers Python work** |
| response size | an unbounded id response is ~380 MB of JSON that lands on Girder *and* the browser |
| client concurrency | one request per plot = N concurrent full-dataset scans; serialize or pool them |

Three rules that each came from a real finding:

1. **Check budgets AS they accumulate, before converting/retaining.** A
   guard that validates after building the thing it guards against has
   already paid the cost — the id-budget check held ~7M ObjectIds on its way
   to returning a 400.
2. **Bound what the DATA can produce, not just what the request asks for.**
   Categories derived from annotations explode on a dataset where every
   object carries a distinct tag; the API-boundary check cannot see that, so
   re-check after deriving (helper raises `ValueError` → API maps to 400).
3. **A backend limit needs its client counterpart.** Lowering a server cap
   without one meant a 21st plot 400'd every request, the client turned that
   into `null`, and the changed-input path had already cleared state — every
   gate stopped filtering with no path to recovery.

**Pick limits from measurement, not intuition.** A "whichever is smaller"
rule for `$in` vs `$nin` looked obviously right and *lost* time near the
crossover, because `$nin` costs ~1.4× per element. Time both and put the
table in the comment.

## A dict that is both client input and an internal write target

When a request dict is validated at the boundary and then *written to* by
internal code, an allowlist is not enough — the validator must **remove**
keys it does not own. Two things conspire:

- validators check the fields they know about and pass everything else
  through untouched;
- internal writers commonly use `setdefault(...)` / `.get(...) or []`, which
  **appends to** a client-supplied value instead of replacing it.

On PR #1302 `filters["gateMatchClauses"]` was internal — the gate resolver
wrote it and the pipeline builder spliced its contents straight into
`$match.$and`. A client could set it on three `@access.public` endpoints:

```python
# Uncaught 500: andClauses += "x" -> {"$and": ["x"]} -> OperationFailure
{"filters": {"gateMatchClauses": "x"}}
# Arbitrary operator ANDed into the dataset match, on a public endpoint
{"filters": {"gateMatchClauses": [{"tags": {"$regex": "(a+)+$"}}]}}
```

Rules:

1. **Strip internal keys at the top of the validator**, before anything
   reads the dict: `filters.pop("gateMatchClauses", None)`. Stripping (not
   rejecting) is right for a key that is not part of the client-facing
   shape — the request simply ignores it.
2. **Grep the writers, not the readers.** The reader
   (`_buildListMatchStages`) looks innocuous; the bug lives in the fact that
   the same dict has two authors. Search for `setdefault`, `.get(x) or []`,
   and `dict[...] =` against any name that also reaches a request body.
3. **Test it from the client side.** Every existing test set the key through
   the resolver, so none of them could see it. Assert the request *succeeds
   and ignores it*, with a clause that would visibly narrow the result if it
   were applied — otherwise "stripped" and "applied but harmless" look the
   same.

## Loading Plugin Changes Into the Running Backend

The `girder` container bakes the plugin into its image (no source mount). After editing backend plugin code:

- `docker compose restart girder` does **NOT** load the change — new routes return `No matching route` while old ones work.
- Required: `docker compose build girder && docker compose up -d girder` (fast — cached layers; girder is back in ~7s).
- `tox` runs against plugin **source**, so tests pass even when the live `:8080` API is stale. Always rebuild before verifying endpoints with curl or the browser.

## Measuring a Mongo write path: re-running the same write measures nothing

WiredTiger largely no-ops a `$set` that writes the value a document already
holds. So a benchmark loop that repeats the *same* operation measures real work
on its first iteration and near-nothing afterwards — and a median over those
runs is meaningless. This actively misled a real optimization: repeated
identical colorings made the write path look **2.6s** when it is ~5s, which
pointed the work at the read path while 80% of the request was writes.

Two rules for any write-path measurement:

- **Force a real change between runs.** Alternate between two different values
  (two colormaps, two field values) so every document genuinely changes each
  iteration, and report the spread rather than a median of no-ops.
- **Instrument inside the request, not in a standalone script.** A separate
  pymongo script misses everything the server does around the write — and, in
  particular, misses *contention between phases*: a dataset-wide clear left
  ~700K dirty pages that doubled the cost of the writes that followed it, which
  no isolated per-phase timing revealed. Temporary `print(...)` in the model,
  read back with `docker logs girder`, is enough (girder's `logprint` is not
  importable from `girder` and its logger's INFO does not reach stdout).

Also worth knowing before reaching for a clever pipeline: a server-side
`$merge` that computes the new value and merges it into the target collection —
no ids crossing the wire, no separate clearing pass — measured **12.6s against
~4.5s** for a plain batched `bulk_write` of `UpdateMany` ops. Measure it before
assuming "push it into the database" is faster.

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

### Every Job Title Reaches Users — Never Ship a Placeholder

Job titles are user-visible: they are listed in Settings → **Jobs & Logs** and quoted in the frontend's job notifications (`src/store/jobs.ts`). A title that doesn't identify the work is a support burden — issue #1294 was a `girder_job_title` defaulting to the literal `"unknown"` for worker *interface* requests (containers named `unknown_None_<ts>`), which users saw appear right before their segmentation run with no way to tell the two apart.

Rules when adding a job, or a helper that creates jobs:

- **Default to something meaningful, not a placeholder.** If the title comes from caller-supplied data (`params.get("name")`), fall back to the request/job type, never to `"unknown"`. Check *every* caller — one caller omitting the field is how the placeholder reaches production.
- **Derive the container name and the title separately.** Docker names allow only `[a-zA-Z0-9_.-]`, so sanitizing shared text costs the title its spaces, `/` and `:`. `runJobRequest` takes an explicit `jobTitle` for this reason (`server/helpers/tasks.py`).
- **Don't interpolate `None` into a name.** Join only the parts that exist — `datasetId` is absent for interface requests.
- **A caller-supplied name may not be a string.** `re.findall` on an int is a 500; guard with `isinstance(name, str)`.
- **If users didn't start the job, document it** in `girder-claude-chat/girder_claude_chat/help/troubleshooting.md`, so the assistant can answer "what is this job?" instead of guessing.

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

### Two ways a backend test lies (both shipped in PR #1278)

**1. Never assert an order that depends on wall-clock timing.** MongoDB stores datetimes at **millisecond** resolution. A test that creates one document, then touches another to make it "more recent", routinely lands both in the same millisecond — the sort then has a tie and Mongo returns an arbitrary order. The test passes alone and fails as soon as another test file shifts the timing, which reads like flakiness in unrelated code:

```python
# BAD: both land in the same millisecond; the assertion is a coin flip.
older = createCollection(admin, folder, "older")
createCollection(admin, folder, "newer")
Collection().updateFields(older, description="touched")   # "now newest"

# GOOD: write the timestamps, so the expected order is unambiguous.
base = datetime.datetime(2026, 1, 1, 12, 0, 0)
older['updated'] = base
newer['updated'] = base + datetime.timedelta(hours=1)
Collection().save(older)
Collection().save(newer)
```

Also **scope the request to the test's own folder**. An exact-list assertion against an unfiltered cross-folder listing is at the mercy of every other test file. And run the file *after* a big one (`tox -- .../test_annotations.py .../test_collection_list.py`), not just alone — order-only failures are invisible to a single-file run.

**2. A clamp test with production-sized constants cannot fail.** Asserting that `limit=0` is capped at 10,000 is vacuous when the fixture has 3 documents: capped and uncapped both return 3. `monkeypatch` the ceiling down so the difference is observable:

```python
def testClampsLimit(self, admin, server, monkeypatch):
    monkeypatch.setattr(collectionApi, "MAX_COLLECTION_LIST_LIMIT", 2)
    # ...create 3 documents...
    resp = ...  # limit=0
    assert len(resp.json) == 2      # fails at 3 without the clamp
```

This requires the handler to read the module constant **at call time** (a module-level helper referencing the global does; a default argument captured at import does not). Note `limit=-1` may pass such a test by accident — PyMongo's `limit(-1)` returns at most one document — so assert the `limit=0` case specifically, which is the one that means *unlimited*.

`test/conftest.py` has an autouse fixture that drops model singletons and
event handlers left over from earlier tests before each test's `db`
setup. Without it, setup re-indexes every model ever created and the
suite slows quadratically (it had reached 75–98 minutes in CI). Don't
remove it. A test that passes alone but fails in the full run with
`Cannot use MongoClient after close` is using a stale model reference
(a cached `Model()` or an event handler bound to an old instance).

## Codebase Documentation References

- When modifying sharing/access code: read `codebaseDocumentation/SHARING.md`
- When modifying project backend code: read `codebaseDocumentation/PROJECTS.md`

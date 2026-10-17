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

**Removing access:** the share endpoints take `-1` on the wire, but Girder's `setUserAccess(doc, user, level)` deletes the entry **only when `level is None`**. Pass `-1` and Girder stores an inert `{id, level: -1}` entry: the user can't read anything, yet still shows up in access lists. Convert at the API boundary with `parseShareAccessType()` (`server/helpers/access_helpers.py`). A test that checks only "user can no longer read" passes with the bug present, so assert the user has **no entry** in `doc['access']['users']`.

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

### Ids that match nothing get no access check

Bulk endpoints usually check access on the datasets of the documents an id list resolves to (`distinctDatasetIds` → `requireDatasetsAccess`). An id that matches no document resolves to no dataset, so nothing about it is checked. That is harmless only if nothing downstream acts on the raw id. The bulk-delete cleanup cascade did: it removed connections and property values pointing at the id in **any** dataset. Leftover orphans in other users' datasets could therefore be deleted by naming their dangling ids. Anything that fans out from caller-supplied ids (cascades, events, follow-up queries keyed on the id rather than the loaded document) must run only for ids that resolved to a document the caller was checked against. `Annotation.multipleAnnotationsRemovedEvent` filters to existing annotations before triggering cleanup (#1418, Codex P2).

### Never return a document that carries `access` raw

`findWithPermissions` and `@loadmodel` decide which **documents** a caller sees. Neither decides which **fields** they see. Any plugin model built on `AccessControlledModel` (every `ProxiedModel`) stores an `access` ACL that lists every collaborator's user id, and `GET user/{id}` turns those ids into names. When a model defines no `exposeFields`, returning its raw doc hands that list to every reader, anonymous viewers of public datasets included. This has happened with dataset views, properties, worker interfaces and previews, and with the JSON export and Zenodo archive, which embed docs without going through any endpoint.

- Give the model `CLIENT_FIELDS` and `exposeFields(level=READ, fields=("_id",) + CLIENT_FIELDS)` in `initialize()`, and put `@filtermodel(model=...)` on every endpoint that returns its docs (get, find/list, **create**, update).
- For exports, which bypass `filter()`, use a `fields=` projection (`AnnotationProperty.findClientFields`).
- Treat the write side as the twin: a create or update that stores the raw body lets the caller set `access` or `public`. Allow-list the body with `filterUpdateFields(requireObjectBody(...))`.
- `filter()` adds `_accessLevel`, computed from the doc's own ACL. If that ACL is not what grants reads (properties are read through configurations; worker docs by anyone), the value is wrong, so mix in `UngatedAclFilterMixin` (`helpers/customModel.py`).
- A response that **names** related resources leaks too: an access list or summary built with plain `find()` (e.g. `configuration_access` listing every dataset opened with a configuration) must use `findWithPermissions` for the caller.
- A caller-supplied Mongo query probes hidden fields through *which* documents match, even when the response is filtered (`{"access.users.id": X}` on `folder/query` was an ACL-membership oracle). Validate it with `requireQueryOnFields(query, exposedFields)` from `helpers/validation.py`.
- Test with a READ-only caller and an anonymous one, and assert both that `access` is absent and that every field the consumers read survives.

### Gate on the ACL that actually grants access

The fields rule above has a twin on the access side. A property's own ACL names only its creator and is never shared, so `@loadmodel(level=READ)` or `findWithPermissions` on properties refuses every collaborator, even though they read the property through a shared configuration. Property compute shipped this way: a WRITE collaborator's "Compute all" returned 403 for every property they could see. Before gating an endpoint on a model's ACL, check whether that ACL is what grants reads (the `UngatedAclFilterMixin` models). For properties, use `_readableThroughConfigurations` in `api/property.py`: one `$in` query returns the requested ids that some READ-able configuration's `meta.propertyIds` references. `getBatch` and the compute endpoints (`_loadComputableProperties`, which also accepts the property's own ACL) both use it. Test it with a collaborator who is not on the document's ACL.

### `rest.*.before` listeners need their own access level

Girder runs `Resource._defaultAccess` on every listener bound to a `rest.<method>.<route>.before` event. A listener with no `accessLevel` attribute makes Girder demand **site admin for the whole route**. `shareLinkGuards.refuseDownloadForLinkUsers` shipped this way, and every non-admin user's folder/item/file downloads and JSON/CSV/GeoJSON exports returned 403 "Administrator access required." Decorate such listeners with `@access.public`. That only sets the attribute; the route handler's own decorator still enforces access afterwards. Tests that exercise only the `admin` fixture can't see this, so test guarded routes with a non-admin `user`, and assert the refusal **message**, not just the 403.

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

### Constants read by more than one module live in `server/helpers/constants.py`

A constant used by one module stays in that module. Once a second module needs it, move it to `server/helpers/constants.py` and import it from there in **every** user, including the module that first defined it. Don't import it from the module that happened to define it first. `MAX_IDS_PER_QUERY` lived in `models/propertyValues.py` while `access_helpers` and the bulk-delete cleanup imported it from there. Tuning it for property values would then have silently changed annotation deletes too (pchoisel, PR #1418).

Event names count as constants too. An event is a string nothing type-checks, so a renamed emitter with a stale subscriber fails silently: the handler simply never runs again. Define a custom event's name once in `constants.py` (e.g. `ANNOTATIONS_REMOVED_EVENT`) and have every `events.trigger` and `events.bind`, tests included, import it. Name an event for what it carries now. The old `removeStringIds` carried ObjectIds after the #1243 fix and was renamed.

## ObjectId Handling

```python
from bson import ObjectId

query = {'_id': ObjectId(string_id)}
query = {'_id': {'$in': [ObjectId(id) for id in string_ids]}}
```

Note: `Model().load()` handles ObjectId conversion internally.

### A string `$in` silently matches nothing on an ObjectId field

`{"childId": {"$in": ["61a4..."]}}` returns no documents when `childId` is stored as an ObjectId. No error, just an empty match. This bites events with more than one emitter. The annotation-removal cleanup event (then `model.upenn_annotation.removeStringIds`, now `ANNOTATIONS_REMOVED_EVENT`) used to get ObjectIds from single delete but strings from bulk delete. Its subscribers (property-value and connection cleanup) therefore worked for single delete and silently orphaned documents on bulk delete. The first fix normalized inside one subscriber, so the other stayed broken for months (#1243). Normalize **where the event is triggered**, so every current and future subscriber gets one type. Both emitters in `models/annotation.py` now send ObjectIds. The bulk emitter also chunks the list at `MAX_IDS_PER_QUERY`, because a subscriber that puts the list in a query twice (`$or` of two `$in`s) passes the 16 MiB command limit long before the annotation removal's single `$in` does.

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

### Helpers report; the endpoint decides the HTTP error

A shared helper in `server/helpers/` must not raise an HTTP-flavoured error
for a condition it detects -- `RestException`, or an `AccessException`
standing in for one ("these no longer exist; discard and re-upload"). It
returns what it found (the ids that exist, the entries that failed) or
raises a domain error, and the endpoint that called it raises
`RestException` with the status and message that fit *that* endpoint
(pchoisel, PR #1410: *"A helper should not raise this kind of API-related
exceptions. The API that uses this helper should receive an error from this
helper then should raise this kind of exception"*).

Why it matters, beyond layering: the same helper often has callers that need
the opposite answer. `requireResourcesAccess` grew a `requireAll=True` flag
that raised for missing resources, needed by Zenodo *publish* (a deleted
resource's files are still in the draft: refuse) while the upload *job*
calls the same helper and must just drop what vanished. A flag that switches
the helper into "raise for the API" mode is the tell; return the found set
and let each caller compare.

- **Look for it:** `raise RestException` / `raise AccessException(...)`
  with a hand-written message in `server/helpers/*.py`, and boolean
  parameters (`requireAll`, `strict`, `raiseIfMissing`) whose only effect is
  to raise.
- **Fix:** return the result (`existingIds, docsById` or a list of bad
  entries); in the endpoint, compute what is missing/invalid and raise
  `RestException(message, code=...)` there. Pick the status in the endpoint
  (a missing resource in a stored draft is a 409 conflict, not a 403).
- **Test both halves:** the endpoint test asserts the status *and* message;
  a helper test asserts it returns the partial result instead of raising.
- **Still fine in a helper:** Girder's own `model.requireAccess(doc, user,
  level)` (the model's access check, not a message the helper invented),
  and the request validators in `helpers/validation.py`, which exist to map
  malformed request fields to a 400 and are only called from API code.
- Older helpers that raise `RestException` themselves
  (`requireAnnotationsInDatasets`) predate this rule; convert them when you
  next change them rather than copying the pattern.

### Validating caller input is an API job — even when the model "could" do it

The layer rule is about **whose data it is**, not which exception type gets
raised. A check that asks *"is what this caller sent consistent with what they
are authorized for?"* — does this `annotationId` belong to the `datasetId`
they have WRITE on, does this property id exist in this dataset, is this
parent in the same dataset as the child — is input validation, and it goes in
the API method (or a `server/helpers/` function the API calls), next to the
access check it completes. The model receives already-validated data and does
the DB modification (pchoisel, PR #1358: *"This check needs to be done at the
API level, not in the model. The API is responsible for validating the input
data and passing it to the model for the DB modification"*).

- Raising `ValidationException` instead of `RestException` does **not** make a
  request-input check belong in the model. PR #1358 put a
  "annotation belongs to dataset" lookup in
  `AnnotationPropertyValues.appendMultipleValues` raising
  `ValidationException`; it passed every layer grep and was still flagged.
- Putting it in the model also taxes internal callers that already know the
  answer (the import path writes values for annotations it just created in
  that dataset) and forces tests to bypass the model (`collection.insert_one`)
  to set up legitimate fixtures — both are tells the check is misplaced.
- When several endpoints need the same check, write it once in
  `server/helpers/` (beside `requireDatasetsAccess` in
  `helpers/access_helpers.py`), batch-load with `$in`, and call it from each
  endpoint -- but have the helper **report** the problem and let each
  endpoint raise the HTTP error (next section).
- Document the precondition in the model method's docstring ("callers must
  ensure each annotation belongs to its datasetId") so internal callers know
  the model trusts them.
- Test it at the endpoint (`server.request(...)` → `assertStatus(resp, 400)`),
  not by calling the model directly.
- **Moving a check up a layer reorders it ahead of the model's schema
  validation.** The model's `jsonValidate` used to turn a non-object entry
  into a 400; once the API helper ran first and called `entry.get(...)`, a
  string entry or a dict-instead-of-list body became a 500. Guard the body's
  shape (`requireList`, `requireObjectBody` per entry) before the new check,
  and use `.get()` for ids the schema doesn't require.

Domain invariants that hold regardless of who calls (schema shape, "a
connection can't link an annotation to itself") still belong in the model.

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

## Concurrent writers: no read-merge-write, no delete-then-insert

Property workers run in bursts (4–5 jobs within a second, several over the
same annotations), so any write path is hit concurrently in production.
Issue #1356: `saveMany` "updated" documents by `removeWithQuery` then
`insert_many`, and property values merged by reading the stored doc in
Python first. Two writers raced into `E11000 ... index: _id_`, the loser had
already deleted its batch (lost data), and a stale merge overwrote a
sibling's values.

- **Merge on the server.** `UpdateOne({key: k}, {"$set": {"values.<id>": v}},
  upsert=True)` per document in one `bulk_write` — never find, merge in
  Python, then write back.
- **Replace in place.** `ReplaceOne({"_id": id}, doc, upsert=True)` is atomic
  per document; delete-then-insert is not.
- **Racing upserts duplicate documents** unless the filter key is unique.
  If adding a unique index would need a data migration, set
  `_id` to the natural key on insert (`$setOnInsert: {"_id": annotationId}`):
  the loser gets an `11000` on `_id` instead of a second document, and one
  retry of just those ops (`ordered=False`, retry by `writeErrors[].index`)
  merges into the winner's.
- **`BulkWriteError.details` / `WriteError.details` are dicts.** Format them
  (`"%s" % ...`) and `raise ... from e`; `"msg" + e.details` turned the real
  error into a `TypeError` 500 (issue #1357).
- **Authorize by the key the write matches on.** The endpoint checked WRITE
  on the body's `datasetId`, but the upsert matched by `annotationId` alone,
  so WRITE on your own dataset let you overwrite another dataset's values
  (Codex P1, PR #1358). When the check and the write key differ, verify
  they agree first (batch-load the annotations' `datasetId`s and reject
  mismatches) — in the **API layer**: `requireAnnotationsInDatasets` in
  `helpers/access_helpers.py`, called by both endpoints. It first landed in
  the model and was flagged (see "Validating caller input is an API job").
- **Test with real threads + a `threading.Barrier`** over a few hundred
  documents and several rounds (`test/test_save_many.py`). It fails reliably
  without the fix; a single-threaded test cannot see the race.

## Girder setting validators can be skipped: check the value in effect

`@setting_utilities.validator` runs only on `Setting().set`. A null
`PUT system/setting` (unset) and a `GIRDER_SETTING_<KEY>` environment
override (JSON-decoded, else the raw string) reach `Setting().get` without
it. A feature gated on its settings must not trust them at runtime. On
PR #1421 Codex found this one setting per round (the issuer, then the
API URL and secret), and a bare-string host list from the environment
turned an `in` check into a substring match.

Fix it once for every setting: give each one a **normalizer** that returns
the value as it should be stored or raises `ValidationException`. Register
one validator that stores the normalizer's result, and have the runtime
gate run the same table over `get(key)`. A value is usable when normalizing
leaves it unchanged. Add a test that asserts the bad-value table covers
every key, so a new setting cannot be added unchecked
(`McpOAuthPlugin/nimbus_mcp_oauth/settings.py` `NORMALIZE`). Drive tests
through the real path: `monkeypatch.setenv('GIRDER_SETTING_...')`, then
`Setting()._get.invalidate(Setting(), key)` (`get` is cached).

## Keying a rate limit on the client address

Girder turns on CherryPy's proxy tool (`tools.proxy.on`), so before any handler
runs `cherrypy.request.remote.ip` is **already the first `X-Forwarded-For`
entry**, not the socket peer. Two consequences:

- The header must be one the proxy owns. Production HAProxy did not set it (no
  `option forwardfor`), so a client could put anything there and rotate it to
  dodge a limit (Codex on PR #1421). It now does
  `http-request set-header X-Forwarded-For %[src]`, which replaces whatever the
  client sent.
- Code cannot check "did this come from our proxy" with `remote.ip`: it is the
  header's value. A first fix that trusted the header only from a private
  `remote.ip` did nothing, and its unit test passed by monkeypatching a
  `remote.ip` the real stack never presents. Key on `remote.ip` and test
  through `server.request(..., additionalHeaders=[('X-Forwarded-For', ...)])`
  (`McpOAuthPlugin/.../rest.py` `_clientAddress`,
  `testRateLimitKeyIsTheAddressTheProxyGives`).

Anything else keyed on `remote.ip` changes meaning when the proxy starts setting
the header: the anonymous raster limiter went from one bucket per dataset to one
per client, so its table needed a sweep.

Girder already refuses a repeated parameter (`code=a&code=b`) with a 400 in
`girder.api.rest._preventRepeatedParams`, query and form body alike, before the
endpoint runs, so endpoint code never sees a list. Don't add a second check.

## Single-use credentials: claim atomically, and only after the request is well-formed

One-time codes, refresh tokens, invite links, consent requests: claim them
with a conditional update (`Model().update({'_id': h, 'used': False},
{'$set': {'used': True}}, multi=False)`, then check `modified_count == 1`);
a find-then-save lets two requests both win.

Then watch **what fails after the claim**. In the MCP OAuth plugin
(`McpOAuthPlugin/nimbus_mcp_oauth/oauth.py`, PR on branch
`claude/mcp-phase3-oauth`) the same bug was found three review rounds in a
row: a refresh with a missing `client_id`, then one with a non-canonical
`resource`, failed *after* the refresh token was marked used, so the
client's corrected retry looked like token reuse and the whole connection
was revoked. Sort every post-claim error into one of two kinds:

- **Malformed request** (missing or mismatched parameters a well-behaved
  client could get wrong): check it **before** the claim. If it needs the
  stored record, peek with the same `used: False` filter, then claim.
- **Security event** (wrong client, replay): claim first, then revoke.

A peek must not soften a security event: the resource peek only applies
when the client matches, or a wrong client could probe a token without
tripping the revocation (review round 4). Test each malformed-request
case with a **corrected retry that succeeds**; a test that only checks the
error response cannot see a spent token.

Sort by *who could cause it*, not by which parameter it is: a field the
legitimate client sends and could mistype (`client_id`, `redirect_uri`,
`resource`) is malformed; a failed proof of possession (a PKCE verifier) is
a security event even though it is "just a parameter". Codex found the
`redirect_uri` case a round after `resource`, because the first fix moved
the one parameter it was shown.

Apply the split to **every** credential of the kind, not the one that was
reported: the refresh path got its resource peek and the authorization-code
exchange, its twin, did not until a later round. And the read after the
claim can come back empty (a TTL index deleted the expired record in
between), so treat `None` there as the same `invalid_grant`, not a crash.

## Index changes on existing collections: not at startup

Any `create_index` / `drop_index` / `ensureIndices` you add to a model
`__init__` or `initialize` runs on **every Girder start, in every uvicorn
worker at once** (production: 9), against production-sized collections
(`annotation_property_values` is 35M documents). PR #1347 dropped the
non-unique `annotationId_1` there and rebuilt it unique. In production
(2026-10-09) that left the collection with **no index for 6 h** and Girder
crash-looping:

- **Workers race.** One drops the index; the rest hit `IndexNotFound`.
- **Builds outlive the 60 s client socket timeout.** The worker raises
  `TimeoutError` and restarts; the server-side build does **not** stop. Each
  restart queues another `createIndexes`, and Mongo runs the queue serially
  long after the instance is gone (72 builds, ~4 h).
- **Drop-then-build leaves nothing** when the build is slow or fails.
- **A unique build fails outright on existing duplicates**, and an
  `except DuplicateKeyError: coalesce()` fallback never fires if the
  client timed out first. 765k duplicate groups were in the data.
- The production app DB user cannot run `collMod`, `currentOp`, or read
  Atlas logs, so you can't watch or convert an index from the app.

Rules:

- **Ship index changes on existing collections as an operator step**: a
  script run once, with a report-only mode, then verified, and run BEFORE
  the new backend boots. Example:
  `upenncontrast_annotation/scripts/dedup_property_values.py`. Such a
  script must not instantiate the model whose `__init__` changes the index.
  `ensureIndices` on a **new** (empty) collection at startup is fine.
- **Never drop an index before its replacement exists.** Build the new one
  alongside, or convert in place (`collMod` `prepareUnique` → `unique`)
  where permitted.
- **Before adding a uniqueness constraint, count the violations** on real
  data (stream the index in key order and count adjacent repeats; see the
  script) and ship the merge as part of the operator step.
- **Startup code must work before and after the operator step.** E.g.
  #1347's startup is safe once the index is already unique: no drop, and
  `create_index(unique=True)` is an instant no-op.
- **Flag it in the PR description** under a "Deploy" heading: which
  collection, its production size, and the command the operator must run
  before rolling backends.

Full incident, numbers, and procedure:
`codebaseDocumentation/PROPERTY_VALUES_UNIQUE_INDEX.md`.

## Returning a large JSON body from numpy (orjson + raw response)

Two traps, both hit by the spatial plugin's `column` endpoint (hundreds of thousands
of `(annotationId, value)` pairs):

- **Girder JSON-encodes whatever the handler returns.** Returning `orjson.dumps(...)`
  bytes without marking the response raw ships a JSON *string* containing JSON — the
  client's `resp.json` is a `str`. Call `setRawResponse()` (from `girder.api.rest`)
  and set the `Content-Type` header yourself, or return a generator (the annotation
  plugin's `_streamJsonArray` pattern).
- **`orjson.OPT_SERIALIZE_NUMPY` takes numeric and bool arrays only.** A unicode
  (`U24`) array of ids raises `TypeError: unsupported datatype in numpy array`;
  `.tolist()` the string array, keep the numeric one as numpy. Cast integral floats
  to `int64` first if the sibling endpoint returns ints, so the two agree.

```python
setRawResponse()
setResponseHeader("Content-Type", "application/json")
return orjson.dumps(
    {"annotationIds": ids.tolist(), "values": values},
    option=orjson.OPT_SERIALIZE_NUMPY,
)
```

## Virtual property paths (`helpers/valueProviders.py`)

A property path whose first segment is a registered prefix is answered by another
plugin's provider, not Mongo. If you add a new consumer of property paths (anything that
reads `values.<path>` or filters/sorts on one), route it through the hook or refuse
virtual paths explicitly — the six existing consumers are listed in
`codebaseDocumentation/SPATIAL_PLUGIN.md` "Phase 2". Two traps from wiring them:

- Providers key by id **string**; Mongo paths yield ObjectIds. `colorByProperty`'s
  membership guard compared the two and silently emptied the map ("No values found").
  Convert at the boundary.
- `appendMultipleValues` `$set`s every property id it is given, so writing a virtual
  path through it would persist (and then shadow) the provider's value — providers are
  read-only; never store a virtual path.
- **A derived table's rows are not the dataset's cells.** The spatial table keeps rows for
  deleted or moved cells until a recompute, so any read meaning "all cells" (an
  unfiltered aggregate, `values()`, a complement like "everything else") must go through
  `store.liveRowMask()`, never `rows=None` / `~maskA` / `store.annotationIds`. Codex found
  this one call site per round for four rounds; the fix was one cached mask used by all.
  The Mongo twin: property values are scoped by `datasetId`, so anything that moves an
  annotation between datasets must move its value documents too (`updateMultiple`).

## A second plugin next to `upenncontrast_annotation`

`upenncontrast_spatial` (`devops/girder/plugins/SpatialPlugin/`) is the template:

- Declare the dependency by calling `getPlugin("upenncontrast_annotation").load(info)`
  first thing in `load()` — Girder 5 has no `dependencies` attribute; the wrapper makes
  the second load a no-op.
- The annotation plugin's `server/` tree has no `__init__.py`, so its sdist/wheel does
  **not** ship it (its own tests import from the source tree). A sibling plugin's tox must
  install it **editable**: `deps = -e {toxinidir}/../AnnotationPlugin`. That install
  leaves `AnnotationPlugin/build/` behind — gitignored.
- Import the annotation plugin's `validation.py` helpers, access helpers and models;
  never mirror a private method's field list. When you need one (the spatial API needed
  `_hasAnnotationFieldFilters`), add a public method on the annotation model
  (`narrowsPopulation`) and call that.
- `@pytest.mark.plugin("upenncontrast_spatial")` loads both plugins; the "Event binding
  already exists" warnings in the test log are the annotation plugin's handlers being
  bound once per plugin load and are harmless.

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

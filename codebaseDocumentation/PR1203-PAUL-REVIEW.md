# PR #1203 — Paul Choisel review round (2026-07-13)

Findings from Paul's review comments, verified against current branch code.

## P1 — `listAnnotationIds` uses `params, *args, **kwargs` + `@memoizeBodyJson`

- **Where:** `server/api/annotation.py:581`
- **Comment:** Expecting only the request body; handle like `datasetView.py` `create` (call `self.getBodyJson()` directly).
- **Verdict:** fix. The endpoint has no `@recordable`, so `@memoizeBodyJson` buys nothing; the `*args/**kwargs` signature exists only to receive the memoized kwarg.
- **Status:** fixed (tox: 295 passed)

## P2 — `listAnnotations` same as P1

- **Where:** `server/api/annotation.py:606`
- **Verdict:** fix.
- **Status:** fixed (tox: 295 passed)

## P3 — Can a tag be named `exclusive`?

- **Where:** `server/models/annotation.py:303` (`_buildListMatchStages`)
- **Comment:** "Does this mean that one cannot create a tag named `exclusive`? … it should be a separate request argument"
- **Verdict:** by-design / already-separate. The list-filter `tags` field is a structured object `{values: string[], exclusive: bool}` (validated at the API boundary in `helpers/validation.py:259-266`), so `exclusive` IS a separate request argument — tag names live only in `values`. A tag literally named "exclusive" works fine. Action: clarify the comment at the site so the shape is obvious; draft reply for Paul.
- **Status:** fixed (docstring clarified in _buildListMatchStages; no behavior change needed)

## P4 — `_propertySortAddFields` hard to read

- **Where:** `server/models/annotation.py:427-436`
- **Verdict:** fix — add explanatory comment for the `_sortValue`/`_hasSortValue` `$ifNull`/`$ne` construction.
- **Status:** fixed (tox: 295 passed)

## P5 — Constants should be at top of class

- **Where:** `server/models/annotation.py:362` (`_SORTABLE_FIELDS`), `:371` (`PROPERTY_VALUES_COLLECTION`)
- **Verdict:** fix — move both to the top of the `Annotation` class.
- **Status:** fixed (tox: 295 passed)

## P6 — `_pvModel` manual lazy-cache is redundant

- **Where:** `server/models/annotation.py:455-463`
- **Comment:** Girder already lazy-loads and caches model instances (`_ModelSingleton` metaclass, model_base.py#L73).
- **Verdict:** fix — drop `_pvModelCache`; construct `AnnotationPropertyValues()` in `__init__` like `api/annotation.py` does with `AnnotationModel()`. No circular import (propertyValues.py does not import this module), so top-level import is fine.
- **Status:** fixed (tox: 295 passed)

## P7 — `$count: "n"` → name it `count`

- **Where:** `server/models/annotation.py:548-555` (`_pvHasValueCount`)
- **Verdict:** fix — rename field to `count` for debuggability.
- **Status:** fixed (tox: 295 passed)

## P8 — Top-level: audit all `@memoizeBodyJson` uses ("not useful everywhere")

- **Audit result:**
  - `connections.py` (create, multipleCreate, deleteMultiple, update, connectToNearest): all paired with `@recordable` whose dataset-finder reads `memoizedBodyJson` → **legitimate, keep**.
  - `annotation.py` create / createMultiple / deleteMultiple / updateMultiple: same → **legitimate, keep**.
  - `annotation.py` `update` (line 229): its `@recordable` finder is `getDatasetIdFromLoadedAnnotation` (reads the loaded model, not the body) → memoize is pointless → **fix** (pre-existing, but in scope of Paul's ask).
  - `annotation.py` `compute` (line 470): no `@recordable` at all → **fix** (pre-existing).
  - `annotation.py` `listAnnotationIds` / `listAnnotations`: new in this PR, no `@recordable` → **fix** (= P1/P2).
- **Status:** fixed (tox: 295 passed)

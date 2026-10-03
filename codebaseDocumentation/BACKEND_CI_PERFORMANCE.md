# Backend CI Performance

The "Lint and test backend" job grew from about 7 minutes (July 2026, 188
tests) to 75–98 minutes (October 2026, ~800 tests). The test count grew
4.2×; the runtime grew 11×. This doc records why, what fixed it, and what
must stay true for it to stay fixed.

## Cause: a quadratic setup leak

Every database test uses pytest-girder's `db` fixture. On setup it points
each Girder model at the fresh test database by calling `reconnect()` (which
re-creates the model's indexes, several round trips) on every entry in
girder's module-level `model_base._modelSingletons` list. On teardown it
sets each model class's `_instance` back to `None`, **but never removes the
old instance from the list**.

So each test's setup reconnected the current models plus every model
instance created by every earlier test. The list grew by about 20 entries
per test, setup time grew linearly through the run, and total runtime grew
with the square of the test count.

Measured locally (Mongo 8.2.9), on the same 131 tests:

| | setup at test 10 | setup at test 120 | 3 files total |
|---|---|---|---|
| before | 0.24 s | 1.66 s (list: 2,032 entries) | 129.5 s |
| after | 0.06 s | 0.19 s (list: ≤ 22 entries) | 21.9 s |

CI suffers far more than a laptop. Mongo runs as a service container, so
each of the ~2,100 round trips per test mid-run cost a few milliseconds:
the same trivial test took 0.7 s in the first file of a run and 16–18 s in
the late files. Mongo itself was not the bottleneck: its log for a 96-minute
run showed 35K index builds totalling about one minute.

Ruled out: the test bodies (~0.01 s each), the Mongo version (9.0.2 vs 8.2.9
locally: 8.0 s vs 6.7 s), network timeouts (a socket logger saw only the
Mongo connections), tox running two Python versions (`py310` is skipped in
CI), dependency install (~40 s).

## Fix

1. **`test/conftest.py` `dropStaleModelState()`**, run by an autouse
   fixture before each test (autouse fixtures run before `db`). It removes
   list entries that are no longer their class's live singleton, **and**
   the Girder event handlers bound to those stale instances. Models bind
   handlers under fixed names, so a stale instance keeps receiving events
   until a fresh one rebinds the name. Pruning without unbinding broke a
   test whose annotation delete fired a stale `Connections` handler
   (`Cannot use MongoClient after close`).
2. **`@recordable` looks up `HistoryModel()` per call.** It used to create
   the instance in the decorator's `__init__`, i.e. once at import, so every
   recorded endpoint wrote through the first test's History instance. That
   only worked because the leak kept reconnecting stale instances; with the
   leak fixed it caused 17 failures.

Result: all 801 tests pass locally in 1 min 57 s, with setup flat at about
0.17 s per database test.

## Workflow changes

- **Per-plugin workflows.** `backend.yaml` runs flake8 on `devops/girder/`
  and the AnnotationPlugin suite, and ignores changes confined to
  `devops/girder/plugins/girder-claude-chat/`. That plugin has its own
  `claude-chat.yaml`, which needs no Mongo service. Before, a prompt-text
  change to the chat plugin (29 tests, 1.2 s) waited over an hour for the
  AnnotationPlugin suite.
- **Concurrency groups** on the push-triggered test workflows: a newer push
  to a branch cancels that branch's running check. Master never cancels, so
  every merge keeps a result. Before, five pushes to one PR left five full
  backend runs going at once.
- **Mongo pinned** to `mongo:8.2` in CI. `mongo:latest` had silently moved
  to 9.0.2. Production runs on MongoDB Atlas; keep this pin at the major
  version production uses.

## Local runs on Apple Silicon

`test_dataset_multi_source.py` can segfault inside pylibtiff on arm64 macOS
(a ctypes variadic-call ABI issue; Linux and CI are unaffected). The fix,
`_restoreVariadicTIFFGetField()` in `test/conftest.py`, ships with PR #1347.
Until that merges, run that file in the Linux Girder container or exclude it
locally.

## Regression checklist

Setup cost:
- [ ] No stale singletons survive into a test's `db` setup —
      `test_model_state_reset.py::testNoStaleModelsAtTestStart`
- [ ] Stale instances and the handlers bound to them are dropped, other
      handlers kept —
      `test_model_state_reset.py::testDropsStaleModelsAndTheirHandlers`
- [ ] Full suite stays near 2 minutes locally; a sharp rise means the leak is
      back (check `len(model_base._modelSingletons)` at setup) — no test;
      watch the CI duration

Stale references (any of these failing only in a full run, never alone,
points at a cached model instance):
- [ ] Recorded endpoints write history through the live History model —
      `test_import.py::TestDataImportEndpoint::testImportedDataIsRecordedAndUndoable`
- [ ] Bulk annotation delete cleans property values without a live
      `Connections` instance —
      `test_server_list.py::TestPropertyValueCleanup::testBulkDeleteRemovesPropertyValues`

Process:
- [ ] Never cache `Model()` in code that runs once at import (decorator
      `__init__`, module globals, class attributes); call it at the point of
      use. Resource and model `__init__` are fine (rebuilt per plugin load).
- [ ] When a test passes alone but fails in the full suite, suspect a stale
      model reference before suspecting test order.

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
0.17 s per database test. In CI the AnnotationPlugin step dropped from
77 minutes (PR #1366) to 3 min 24 s (PR #1367's first run).

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
- **Mongo pinned** to `mongo:8.0` in CI, production's major version
  (Atlas, MongoDB 8.0.26 as of June 2026, per AWSDeploy's
  `doc/Prod_Mongo_Query_Optimization_Findings.md`). `mongo:latest` had
  silently moved to 9.0.2. Bump this pin when production upgrades.

## Local runs on Apple Silicon

`test_dataset_multi_source.py` used to segfault inside pylibtiff on arm64
macOS (a ctypes variadic-call ABI issue; Linux and CI are unaffected).
`_restoreVariadicTIFFGetField()` in `test/conftest.py` (from PR #1347) fixes
it at import, ahead of the stale-model fixture.

## Regression checklist

Run `tox` in `devops/girder/plugins/AnnotationPlugin` (the whole suite: the
invariants below only bite when many tests run in one session).

### Setup cost stays flat

- [ ] **A model left by one test is gone before the next test's `db`
      setup.** The leak itself; the first test exists only to leave one
      behind. — *"testLeavesAModelBehind"*, *"testNoStaleModelsAtTestStart"*
- [ ] **Stale instances and the handlers bound to them are dropped; other
      handlers are kept.** Pruning without unbinding lets a stale instance
      handle events against a closed client. —
      *"testDropsStaleModelsAndTheirHandlers"*
- [ ] **The full suite stays near 2 minutes locally (about 4 in CI).** A
      sharp rise means the leak is back; check
      `len(model_base._modelSingletons)` at setup. No test can hold this;
      watch the CI duration.

### No stale model references

These fail only in a full run, never alone, when something caches a model
instance across tests.

- [ ] **Recorded endpoints write history through the live History model.**
      `@recordable` used to cache the import-time instance. —
      *"testImportedDataIsRecordedAndUndoable"*
- [ ] **Bulk annotation delete cleans property values without a live
      `Connections` instance.** The test that exposed the stale-handler
      problem. — *"testBulkDeleteRemovesPropertyValues"*

### Process

- Never cache `Model()` in code that runs once at import (decorator
  `__init__`, module globals, class attributes); call it at the point of use.
  Resource and model `__init__` are fine, since they're rebuilt per plugin
  load.
- When a test passes alone but fails in the full suite, suspect a stale
  model reference before suspecting test order.
- Run `pnpm test src/__tests__/regressionChecklist.test.ts` after editing
  this checklist: it checks every cited test name exists.

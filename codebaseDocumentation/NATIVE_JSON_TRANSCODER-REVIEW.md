# Native JSON transcoder (PR #1460): review tracker

Three passes on 2026-11-02, against `origin/master`: the repo's `branch-review` skill, `/code-review` at high effort, and the Codex CLI (`codex review --base origin/master`). Commit `15bcc1c8` belongs to the stacked PR #1458; findings in its lines are reported there, not fixed here.

Status values: `fixed <commit>`, `not real` (with the evidence), `declined` (real, with the reason).

## branch-review

| # | Severity | Finding | Status |
|---|---|---|---|
| B1 | Low | `findRawBatchesByAnnotationIds` requires callers to route virtual paths elsewhere, but only its docstring says so | declined: the one caller routes correctly, and per the repo's don't-over-harden rule a guard for a hypothetical future caller isn't added. Same as C3 |
| B2 | Low | `prefetchedBatches(cursor, depth=2)` repeated in three endpoints, justified in one | fixed: `STREAM_PREFETCH_BATCHES` in `helpers/aggregation.py`. Same as C5 |
| B3 | Nit | `findRawBatches` reads Girder's private `_allowedFindArgs` / `_MAX_CURSOR_TIMEOUT_MS` | declined: mirroring `Model.find` exactly needs them, and `testFindRawBatchesMatchesFind` fails if Girder changes them |

## /code-review (high)

| # | Severity | Finding | Status |
|---|---|---|---|
| C1 | — | `streamRawJsonArray` yields `[` before the first fetch, so a first-batch error becomes a truncated 200 instead of a 500 | not real: Girder's `endpoint` returns the generator, CherryPy calls `start_response` (200) before iterating a streamed body, and the ASGI bridge sends that status with the first chunk or the end. For the endpoints that already streamed (annotation find/hydrate/stubs, and #1458's lists) master also gave a 200, with an empty body. `batch` was a 500 on master (round 2's review pointed this out). There the change is a 500 becoming a truncated 200 for a Mongo error mid-query; the one predictable such error (overlapping paths) is now a 400 up front, and the frontend's only caller fails either way (`.map` on a string throws). Kept as not worth restructuring |
| C2 | Medium | Duplicate-key check scans linearly per key, quadratic in a level's width | fixed: a level switches to a hash set past 16 keys (32 since round 2, see R2-C1). 500 keys at one level: 1,018 → 179 ms per 68 MB; 2,000 keys: 4,101 → 176 ms. Test: crate `wide_documents_stay_linear_and_still_refuse_repeats`, which failed before the fix |
| C3 | Low | Virtual-path precondition stated only in prose | declined, see B1 |
| C4 | Low | CLAUDE.md said `collection.aggregate()` is "the only acceptable use of `collection` directly", but `findRawBatches` uses `find_raw_batches` | fixed: CLAUDE.md (`AGENTS.md` is a symlink to it) and the `branch-review` skill's Raw PyMongo check now name the raw-batch exception |
| C5 | Low | Prefetch depth duplicated | fixed, see B2 |
| C6 | Low | `PyBytes::new` copies each batch's JSON once more | declined: about 3 ms per 16 MB batch (~1%), and avoiding it needs a second pass or unsafe buffer handoff |
| C7 | Low | The builder stage pipes the unpinned rustup installer to `sh` | declined: it's the official installer over TLS with a pinned toolchain, consistent with the image's other build-time fetches (`git clone large_image`, pip `--find-links`) |

## Codex

`codex review --base origin/master` (codex-cli 0.159.3): **no actionable defects.** It ran while the C2 fix was being made in the working tree. It read the old linear key scan, later built the fixed crate, transcoded a 20,000-key document (1.2 ms, byte-identical to orjson) and reported "no actionable defects found in the current diff after rechecking the concurrent performance fix". Its Mongo-backed tests couldn't run inside its sandbox (no network); its Rust tests and Mongo-free Python tests passed. A second run against the final pushed commit is recorded in the PR.

## Verification after the fixes

- Whole-collection byte parity with the fixed wheel (Girder's codec options): 2,531,625 property values, 21,008 connections and 2,548,793 annotations identical to decode + orjson, none refused.
- `cargo test`, `tox -e py311` (full suite) and `tox -e native` re-run against a throwaway Mongo 8.0 container. The local `nimbusimage-mongodb-1` had been OOM-killed under the combined load of several sessions, so it wasn't used.

## Round 2 (head `07ca44bf`)

| # | Pass | Severity | Finding | Status |
|---|---|---|---|---|
| R2-C1 / R2-B1 | /code-review, branch-review | Medium | Round 1's hash-set switch at 16 keys made typical property-value documents slower: Xenium documents have a 31-key level, so each built its own set. Real 100K Xenium read: 165 ms (linear) → 194–202 ms | fixed: threshold 32, from a sweep of 16/32/64/128 over widths 20–2,000 plus the real read (32: 160 ms real, 152 ms at 2,000 keys). A compile-time assertion keeps it above 31 |
| R2-B2 | branch-review | Low | The wide-key test never repeated the key that triggers the switch, and no Python test checked byte parity for wide levels | fixed: the crate test repeats the switch key; new *testWideDocumentsMatchOrjson* covers widths 31/32/33/2,000 and repeats on both sides. Both fail when the switch branch's `insert` is dropped |
| R2-B3 | branch-review | Nit | The Cost checklist item cited only a Rust test, which the checklist validator can't check | fixed: it cites *testWideDocumentsMatchOrjson* |
| R2-B4 | branch-review | Nit | `test_list_streaming.py` (#1458's file) described ~1000-document chunks, stale since raw-batch streaming | fixed here, because #1460 made it stale |
| Codex | Codex | — | Ran on `07ca44bf`: "No actionable regressions were found" | — |

## Round 3 (head `3edeaf28`)

| # | Pass | Severity | Finding | Status |
|---|---|---|---|---|
| R3-B1 | branch-review | Nit | *testWideDocumentsMatchOrjson* only repeated keys above the switch, though the checklist cites it for both sides; its splice comment misdescribed the helper | fixed: added (31, 0) and (32, 31), both caught by the scan (the second at the trigger position); comment reworded |
| R3-B2 | branch-review | Nit | Round 2's rewrite of `test_list_streaming.py`'s docstring said Girder holds "one Mongo batch at a time", but the endpoints prefetch `STREAM_PREFETCH_BATCHES` ahead (~4 batches in flight) | fixed |
| — | /code-review | — | No findings. Checked: `wideDocument` builds valid BSON (lengths, element slice, last-value decode), the test cases hit the intended branches, runtime import shadowing, Docker stage consistency, ImportError-only fallback, edge-case types | — |
| — | Codex | — | Ran on `3edeaf28`: "No actionable regressions were found" | — |

## Round 4 (head `60347b2e`)

| # | Pass | Severity | Finding | Status |
|---|---|---|---|---|
| R4-B1 | branch-review | Nit | The `nimbus-backend` skill's first raw-streaming snippet still used `prefetchedBatches(cursor)` (default depth 4), the docs twin round 1's B2 fix missed. The skill's two sections disagreed | fixed; a sweep of every `prefetchedBatches(` example in docs and skills found no other |
| — | /code-review | — | No findings: round 3's new cases hit the scan path as claimed, and the docstring is true for both endpoints | — |
| — | Codex | — | Ran on `60347b2e`: "No actionable regressions were identified" | — |

## Not in this PR's lines

No finding fell in #1458's commit `15bcc1c8`.

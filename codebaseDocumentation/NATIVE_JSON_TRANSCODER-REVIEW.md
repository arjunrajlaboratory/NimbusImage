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
| C1 | — | `streamRawJsonArray` yields `[` before the first fetch, so a first-batch error becomes a truncated 200 instead of a 500 | not real: Girder's `endpoint` returns the generator, CherryPy calls `start_response` (200) before iterating a streamed body, and the ASGI bridge sends that status with the first chunk or the end. On master the same error gave a 200 with an empty body. Both are a client parse error, not a 500 |
| C2 | Medium | Duplicate-key check scans linearly per key, quadratic in a level's width | fixed: a level switches to a hash set past 16 keys. 500 keys at one level: 1,018 → 179 ms per 68 MB; 2,000 keys: 4,101 → 176 ms. Test: crate `wide_documents_stay_linear_and_still_refuse_repeats`, which failed before the fix |
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

## Not in this PR's lines

No finding fell in #1458's commit `15bcc1c8`.

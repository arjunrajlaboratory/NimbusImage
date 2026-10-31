# Phase 0 spike: results

> Historical record. The spike code (`spike/server.py`, `smoke_test.py`, `test_server.py`)
> was replaced by the Phase 1 package in this directory; the eval harness moved to
> `eval/`. Paths below are as they were during Phase 0.

**Plan:** [`NIMBUSIMAGE_MCP_SERVER.md`](../../codebaseDocumentation/NIMBUSIMAGE_MCP_SERVER.md), Phase 0.
**SDK:** `mcp==2.3.0` (`mcp-types==2.3.0`), Python 3.14. **Package:** `nimbusimage` 0.5.0.
**Data:** local compose stack built from master (95 datasets, up to 709K annotations each).
**First run:** 2026-10-11 on master before #1390/#1391. **Latest run:** 2026-10-11 on master with #1390, #1391 and #1407 (13/13 tasks, 49 calls, 0 errors, 267 MB peak).

## What was built

| File | Purpose |
|---|---|
| `server.py` | Five read-only tools (plan §5.3) as stateless streamable HTTP on `127.0.0.1:8000/mcp`. Single-user auth from `NI_API_URL` / `NI_API_KEY`. Each call is logged (tool, args, seconds, wire bytes, error) to `calls.jsonl` or `NI_MCP_CALL_LOG`. Every tool calls the public `nimbusimage` API; there are no raw REST calls. |
| `test_server.py` | Unit tests for the helpers: logged size versus the SDK's wire format, scale placeholders, crop clipping. |
| `smoke_test.py` | Calls every tool over real HTTP with the SDK client, including a zoomed crop and the error paths. Composites are saved to `out/`. The dataset ids are local. |
| `eval/` | Runs 13 real tasks through headless Claude Code (Opus 5.5), restricted to these tools, in parallel; `summarize.py` reports tool choice, turns, cost and answers. |

```bash
python3 -m venv nimbusimage-mcp/.venv
nimbusimage-mcp/.venv/bin/pip install -e nimbusimage -r nimbusimage-mcp/spike/requirements.txt
cd nimbusimage-mcp
NI_API_KEY=unused .venv/bin/python -m pytest spike/test_server.py
NI_API_URL=http://localhost:8080/api/v1 NI_API_KEY=<key> NI_MCP_CALL_LOG=spike/calls.jsonl \
    .venv/bin/python spike/server.py
.venv/bin/python spike/smoke_test.py        # in another shell
spike/eval/run_eval.sh
claude mcp add --transport http --scope local nimbus-local http://127.0.0.1:8000/mcp
```

## Tools

| Tool | Wraps | Returns |
|---|---|---|
| `ni_datasets_list(name_contains?, limit)` | `client.list_datasets()` (one batched request) | `{total, returned, datasets: [{id, name}]}`, capped at 200 |
| `ni_dataset_info(dataset_id)` | `Dataset` metadata, `pixel_size`, `collections.scales` | Size, channels, z/time/xy counts, `pixel_size_um`, `z_step` (null when unknown) |
| `ni_annotations_count(dataset_id, shape?, tags?)` | `ds.annotations.count` | One number |
| `ni_annotations_summary(dataset_id, max_tags)` | `ds.annotations.summary()` (#1407) | Total, tag counts and shape counts in one server-side aggregation |
| `ni_image_get_composite(dataset_id, xy, z, time, max_size, crop?)` | `ds.images.get_composite(max_size, crop)` | JPEG drawn the way the app draws it; `crop` zooms in |

## Exit criteria

- [x] **Claude Code completes most tasks without hand-holding.** 13 of 13 in the latest run (12 of 12 in each earlier run). Count and metadata answers were checked against MongoDB; the image descriptions were checked by viewing the same composites. In the first run, one pixel size was wrong (task 4); the tool passed on `nimbusimage`'s invented 1 µm, which #1390 fixed.
- [x] **No text response over about 2K tokens.** The largest in the eval was 1.9 KB (~480 tokens). `ni_datasets_list(limit=200)` on 95 datasets is 10 KB; see the Phase 1 list.
- [x] **A written list of tools to add, rename or drop.** See below.
- [ ] **Placement decision.** Still open. This spike provides the inputs below, but the in-process option has not been tried.

## Latest measurements

Eval run with 48 calls and 0 errors, from 13 parallel Claude sessions. Sizes are bytes on the wire.

| Tool | Median | Max | Response |
|---|---|---|---|
| `ni_datasets_list` | 0.03 s | 0.12 s | 0.3–1.9 KB (it was 0.4–1.2 s before #1390 batched the listing) |
| `ni_annotations_count` | 0.01 s | 0.28 s | ~50 B |
| `ni_dataset_info` | 0.04 s | 0.80 s | 0.5–0.6 KB |
| `ni_annotations_summary` | 0.52 s | 1.07 s | 0.2–0.3 KB (it was 4–8 s and +400 MB before) |
| `ni_image_get_composite` | 0.14 s | 0.78 s | 30–240 KB JPEG |

The server peaked at **238 MB** RSS over the parallel eval; it idles at about 98 MB. Per task: a median of 4 turns and 5–29 s. Costs were $0.26–0.36 per task in the latest run, but most of that is Claude Code writing about 31K tokens of its own system prompt to a cold prompt cache; the earlier runs read it warm and cost $0.04–0.12. Tool output is a small share either way.

## Tool selection

Claude Code loaded the tools through tool search, by name, and its first real tool call was the right one in every task of every run. With the `crop` argument, it zooms on its own. Asked to describe the "Xenium tiny" ovary, it found the two tissue patches in the overview, cropped into them, and described the nuclei. The first run could only report two small patches on an empty canvas. Asked how many "nuclei" there were, it still refuses to call the `488 blob` polygons nuclei without evidence.

## Findings, and where they ended up

| # | Finding | Status |
|---|---|---|
| 1 | The first summary tool pulled every annotation into the server (4–8 s, +400 MB per call, 2.3 GB during the parallel eval) | Fixed: uses the existing `POST upenn_annotation/summary` |
| 2 | Shape counts needed one full-dataset scan per shape (no `datasetId`+`shape` index) | Fixed: #1391 adds a `shapes` facet to the summary (+35–54 ms per summary on 465K–709K annotations) |
| 3 | Composites did not match the app: percentile contrast read as quantiles; view overrides and slice settings ignored | Fixed in `nimbusimage` 0.4.1 (#1390). It matches an independent server rendering of the app's style exactly when downsampled, and within 1/255 at full resolution |
| 4 | PNG composites were 1.1–1.2 MB | Fixed: JPEG q85 |
| 5 | Tags with `+` or `&` were mangled; `"CD8+"` was sent as `"CD8 "` | Fixed in #1390 |
| 6 | `pixel_size` invented 1 µm | Fixed in #1390; the tool now reports `pixel_size_um` or null |
| 7 | `list_datasets` made one GET per dataset | Fixed in #1390 (one `resource/batch` call) |
| 8 | `get_composite` had no size option; the spike used private methods | Fixed in #1390 (`max_size`, `crop`); the spike uses only public API |
| 9 | `rectangle` was missing from the shape list | Fixed |
| 10 | Python sharing always returns 400, and access removal leaves stale entries | Issue #1404. It doesn't affect these read-only tools, but blocks any sharing tool |
| 11 | `resource/batch` returns raw access lists | #1396 / #1402 (server). `nimbusimage` already strips them on the client |

## Phase 1: what is left

**Server (`nimbusimage-mcp/` package, plan §5.4, Phase 1):**
- Per-request credentials: a `TokenVerifier` that exchanges a bearer API key for a Girder token and caches it by SHA-256 of the key. Today the spike holds one key from the environment. Add HTTP-level auth tests (missing, invalid, and revoked keys return 401; two users each see only their own data). The SDK's in-memory client skips auth, so it can't test the verifier.
- Package it properly (its own `pyproject.toml`, a pinned SDK), add a container and a compose profile, and log tool name, duration, size and user without credentials.
- Phase 1 tools:
  - `ni_annotations_list` (capped at 200)
  - `ni_properties_list`, `ni_property_values_summary`, `ni_property_histogram`
  - `ni_workers_list`, `ni_worker_interface`, `ni_worker_run` (destructive hint), `ni_job_wait`
  - `ni_annotations_tag` (destructive hint)
  - `ni_help_topic`
- Tool changes from this spike:
  - a multi-dataset count (one task took 16 sequential count calls)
  - a single-channel view
  - a lower `ni_datasets_list` cap
  - compact JSON (the SDK indents dict results, about a third more bytes)

**`nimbusimage` package:**
- Done: `ds.annotations.summary(shape, tags, exclusive, property_paths, filters)` (#1407, 0.5.0). Phase 1's filtered summaries and `ni_property_values_summary` build on it.
- Fix sharing (issue #1404) before any sharing tool is exposed.

**Later phases (plan §6–7, unchanged):**
- the Girder OAuth plugin and consent page (needed for Team/Enterprise connectors)
- a public tunnel test of claude.ai and Desktop connectors
- the AWS deploy changes (HAProxy routes, sidecar image, IP-manager tests) and the test-environment rehearsal
- the production rollout

**Placement (plan §11):**
- The process is light: about 98 MB idle and 238 MB peak, with the heavy work done in Girder and large_image.
- A sidecar is still the lean, because a misbehaving tool can be memory-limited and killed without taking Girder down. Mounting the server inside Girder's ASGI app has not been tried.

## Confirmed SDK facts (plan §12)

- `MCPServer.run(transport="streamable-http", host=…, port=…, stateless_http=True)` exists in 2.3.0, and stateless mode answers `tools/list` without an `initialize` handshake.
- Sync tools run in a worker thread (`anyio.to_thread.run_sync`), so a slow tool doesn't block other requests.
- `TokenVerifier` and `AuthSettings` live in `mcp.server.auth.provider` and `mcp.server.auth.settings`, and `MCPServer(token_verifier=…, auth=…)` accepts them; the spike didn't exercise them.
- Tool types (`ToolAnnotations` and others) live in the separate `mcp_types` package.

## Side notes

- When running `claude -p` in a `while read` loop, add `< /dev/null`; otherwise `claude -p` appends the piped stdin to the prompt.
- The spike's cached client mints one Girder token per server process, not one per call. Phase 1's per-request exchange cache must keep that (plan §6.2).
- Don't run `docker compose up` from a worktree. The assetstore is a relative bind mount, so Girder comes up with an empty assetstore and every tile request returns 500. This happened once during this work.

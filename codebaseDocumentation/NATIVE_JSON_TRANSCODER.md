# Native BSON → JSON for annotation, property-value and connection reads

These endpoints stream their documents through a small Rust extension, `bson_json_native`:
- annotations: the list (`GET upenn_annotation`), hydrate (`POST upenn_annotation/hydrate`) and stubs (`GET upenn_annotation/stubs`);
- property values: the list (`GET annotation_property_values`) and the lazy-mode batch (`POST annotation_property_values/batch`);
- the connection list (`GET annotation_connection`).

The extension turns raw BSON batches from Mongo straight into JSON, without building Python objects. Each response's bytes are what `orjson.dumps(doc, default=orJsonDefaults)` wrote. The one exception is `batch`, which used to go through Girder's encoder (see below).

## Why

A 100K-cell read (Xenium, ~25 `{x, y}` vertices per polygon) used to spend most of its time turning BSON into Python objects: ~13M dicts and floats, built only to be serialized again by orjson.

Live A/B, 2026-11-02: two throwaway Girder servers built from the same image on the same database, master's plugin source against this branch's. The image is amd64, run under emulation on an Apple Silicon Mac. Times are the median of 5 alternating runs, measured from request to last byte by a client on the compose network:

| Endpoint (Xenium, 709K cells) | master | native | Speedup |
|---|---|---|---|
| `find`, limit 10K (13.8 MB) | 256 ms | 131 ms | 2.0× |
| `find`, limit 100K (137 MB) | 1,557 ms | 478 ms | 3.3× |
| `find`, whole dataset (970 MB) | 11.6 s | 2.8 s | 4.1× |
| `hydrate`, 5K ids (6.9 MB) | 73 ms | 36 ms | 2.0× |
| `stubs`, whole dataset (192 MB) | 5.7 s | 5.6 s | 1.0× |

The bodies were byte-identical in every case. Stubs is bound by Mongo evaluating its aggregation, and its decoding was already overlapped by the prefetch thread. What changes there is CPU: the Python work it no longer does is time the GIL is free for other requests.

Property values and connections, measured the same way across master, PR #1458 (which first streamed these lists through orjson, because `limit=0` on master OOM-kills Girder) and this branch:

| Read (Xenium, 709K value documents) | master | #1458 | native |
|---|---|---|---|
| `annotation_property_values` `find`, limit 100K (111 MB) | 5,538 ms | 1,624 ms | 395 ms |
| `annotation_property_values` `find`, whole dataset (785 MB) | OOM | 11.1 s | 2.5 s |
| `batch`, 10K ids (10.4 MB) | 281 ms | 331 ms | 67 ms |
| `batch`, 10K ids, one property path (1.3 MB) | 114 ms | 55 ms | 26 ms |
| `annotation_connection` `find`, 10K connections (1.8 MB) | 120 ms | 94 ms | 16 ms |

`find` bytes are identical to #1458's. The parsed values match master everywhere (master's whole-dataset `find` wasn't run, because it OOMs).

For 100K annotations the JSON body is 137 MB either way. The transcoder releases the GIL, so other requests keep running while it works, and fetching overlaps transcoding (`prefetchedBatches`). The old path also held each 16 MB batch as decoded dicts (around 10× its BSON size); now it stays as bytes.

## How it fits together

- **Crate:** `devops/girder/plugins/AnnotationPlugin/bson-json-native/`, a pyo3 extension (abi3, CPython ≥ 3.9) with one function, `transcode(batch: bytes) -> bytes`. It takes one raw batch (concatenated BSON documents) and returns each document's JSON joined by `,`. The directory name has a hyphen on purpose: as `bson_json_native/` it was importable as an empty namespace package whenever `AnnotationPlugin/` was on `sys.path` (tox, the editable install), so `import bson_json_native` "succeeded" with no `transcode`.
- **Image:** a builder stage in `devops/girder/Dockerfile` builds the wheel with a pinned rustup toolchain and maturin. The final stage only `pip install`s it, so no Rust toolchain reaches it. The builder uses the **same base image** as the final stage. `girder/tox-and-node-lts` is amd64-only, and a builder on a multi-arch base (`python:3.11-slim`) built an arm64 wheel on Apple Silicon that the emulated amd64 image refused to install. If the base ever becomes multi-arch, the wheel follows it.
- **Plugin:** `serialization.streamRawJsonArray(rawBatches, codecOptions, prefix, suffix)` is `streamJsonArray(documents, default=orJsonDefaults)` for documents still in raw batches. `rawBatchJson` does one batch:
  - It uses the transcoder when it is installed and the codec options build plain dicts (`_transcoderMatches`: `dict` documents, no type codecs, strict UTF-8). Girder's client is `tz_aware=True`, which doesn't matter, because datetimes are refused.
  - It decodes and orjson-encodes in Python when the module is missing (dev installs, the default tox env), or when the transcoder raises `ValueError` for that batch.
- **Model:** `CustomNimbusImageModel.findRawBatches` is `Model.find` returning `find_raw_batches`. It reaches `self.collection` directly, the exception to CLAUDE.md's `Model().find()` rule, so it repeats what Girder's `find` adds (allowed extra arguments, cursor timeout, projection). `Annotation.stubBatches` is the stubs aggregation as `aggregate_raw_batches`; `stubs()` decodes it (tests use it, and so can any future Python caller).

## `POST annotation_property_values/batch`: bytes change, values don't

`batch` used to return a list that Girder encoded with `json.dumps(sort_keys=True, allow_nan=False)`. It now streams the same documents in orjson's form: compact, keys in stored order, and Infinity/NaN as `null`, like the list endpoint.
- **Values that change:** a stored Infinity used to make `batch` a 500; it is now `null`. The parsed value is otherwise the same for JSON-typed values: numbers, strings, booleans, null, objects and arrays. Girder's encoder (`JsonEncoder.default`) wrote `str()` of types JSON has no form for, and `isoformat()` of datetimes. ObjectId and datetime still come out the same here (a hex string; an identical tz-aware timestamp). The rest now fail mid-response, because orjson can't encode them: Decimal128, Binary (UUIDs included), Regex, Timestamp, MinKey/MaxKey, and anything pymongo decodes to a DBRef, either a DBPointer or an embedded `{$ref, $id}` document (master wrote `"DBRef('c', 1)"`). None exist in the local data.
- **Overlapping paths:** a path and its sub-path (`["area"]` with `["area", "mean"]`) are refused with a 400 (`validateDisjointPropertyPaths`). Mongo rejects that projection. On master it was a 500; streamed, it would have arrived after the 200 as a truncated body.
- **Stored paths only:** the documents come from `findRawBatchesByAnnotationIds`, the raw twin of `findByAnnotationIds`. The two share their projection and chunked `$in` queries.
- **Any virtual path (`valueProviders`):** values are merged into the documents in Python, then written with `streamJsonArray(..., default=orJsonDefaults)`, so the two paths produce the same form. That path still decodes every stored value in Python. The frontend requests virtual paths whenever a gene column is displayed, so those requests don't get the speedup in the table.

Client compatibility:
- The frontend is the only caller (`PropertiesAPI.getPropertyValuesForIds`, used by `properties.ts`, `filters.ts`, `MontageView.vue`, `ConnectionList.vue` and `agent/executors.ts`). It parses with `JSON.parse` and reads `annotationId` and `values` by key; nothing depends on the raw text or on sorted keys.
- The wholesale-mode list (`GET annotation_property_values`) already lost sorted keys in #1458.
- `nimbusimage` and `annotation_client` don't call `batch`.

## What the transcoder refuses (and the fallback covers)

It renders ObjectId (24-char hex), string, int32/int64, double (orjson's format: ryu shortest digits with `+` before a positive exponent, e.g. `1e+16`, `0.00001`, `1e-6`, `-0.0`; NaN and ±Inf become `null`), bool, null, document and array. It raises `ValueError` instead of writing different bytes for:

- datetime, code, code-with-scope, symbol and undefined, which orjson does serialize after pymongo decodes them;
- binary, decimal128, regex, timestamp, min/max key and DBPointer, which orjson can't serialize either, so the response fails as it did before;
- an embedded document with both `$ref` and `$id` keys. pymongo decodes it to a `DBRef`, which orjson can't serialize, and the fallback reproduces that failure. At the top level such a document stays a dict, and the transcoder renders it;
- a key repeated within one document (pymongo keeps the last value at the first key's position);
- nesting deeper than MongoDB's 100 levels (orjson's own limit is 254; Python reproduces it), invalid UTF-8, and malformed BSON.

A refusal costs only that one batch, which then goes through Python, so the bytes still match. None of the local database's 2.5M annotations, 2.5M property values or 21K connections contain any of these (whole-collection sweep, 2026-11-02, with Girder's codec options).

## Not converted (yet)

- **`POST upenn_annotation/list`** (the paged Annotation Browser list): pages are capped at 10K stub-shaped rows, and they come from three pipeline branches, one of which builds rows in Python, plus Python-side virtual property values. The decode cost is small there.
- **The JSON export** (`export.py`): it builds one dict with every annotation and connection, then dumps it. Streaming it through raw batches would help large exports and is the obvious next step.
- **Connection reads other than the list**, and the property-value histogram and distinct endpoints: they return small aggregates.
- **Overlapping paths in `POST upenn_annotation/list`'s `propertyPaths`** are still a 500 rather than a 400 (as on master). That endpoint isn't lazily streamed, so the error at least arrives before the response.

## Regression checklist

Byte parity (the contract):
- Transcoder output equals decode + orjson for annotation-shaped documents, edge-case floats, strings, ints and nesting: *"testAnnotationsMatchOrjson"*, *"testEdgeCasesMatchOrjson"*.
- Float formatting over 300K random doubles: *"testFloatSweepMatchesOrjson"*.
- The endpoints return byte-identical bodies to the old path, across more than one raw batch, with a fallback batch mixed in: *"testFind"*, *"testHydrate"*, *"testStubs"*.
- Property values (`find`, `batch` with and without projections) and connections (`find`) return byte-identical bodies to the orjson path, and `batch` parses to what Girder's encoder produced: *"testPropertyValuesFind"*, *"testPropertyValuesBatch"*, *"testConnectionsFind"*.
- `batch` with a virtual path is merged in Python and written in the same form; an unknown virtual key is still a 400: *"testPropertyValuesBatchWithVirtualPath"*.
- A stored Infinity in `batch` is `null`, not a 500: *"testPropertyValuesBatchInfinityIsNull"*.
- `batch` across several `$in` chunks keeps chunk order on both paths: *"testPropertyValuesBatchAcrossInChunks"*.
- Overlapping projection paths are a 400 before the response starts, not a truncated 200: *"testPropertyValuesBatchOverlappingPathsIs400"*.
- `streamRawJsonArray` equals `streamJsonArray` with prefixes and suffixes, empty batches, and a fallback batch: *"testSameBytesAsStreamJsonArray"*, *"testEmpty"*.

Fallbacks:
- Every refused type (and DBRef-shaped or too-deep document) either falls back to the same bytes or fails as orjson does: *"testRefusesWhatItCannotRenderExactly"*, *"testUnsupportedTypesFallBackToTheSameBytes"*.
- Codec options that change decoding skip the transcoder: *"testOtherCodecOptionsSkipTheTranscoder"*.
- Girder's real codec options still pass that gate (otherwise every read silently drops to the slow path): *"testGirderCodecOptionsUseTheTranscoder"*.
- Malformed BSON is an error, never a crash or different output: *"testRefusesMalformedBson"* (plus the crate's `cargo test`, which truncates and corrupts every byte).

Cost:
- Repeated-key detection stays linear for wide documents, such as a gene panel with thousands of keys in one dict: a level switches from a linear scan to a hash set past 32 keys, with byte parity and repeated-key refusal on both sides of the switch: *"testWideDocumentsMatchOrjson"* (and the crate test `wide_documents_stay_linear_and_still_refuse_repeats`, which also bounds the time; the 2026-11 review measured 500 keys at 11× slower than orjson before the fix). Typical levels (Xenium property values have up to 31 keys) stay on the scan: a threshold of 16 made them 18% slower, because each document built its own set. Reviews: `NATIVE_JSON_TRANSCODER-REVIEW.md`.

Mongo access:
- `findRawBatches` builds the same cursor as Girder's `Model.find`, so a Girder upgrade that changes `find` fails here: *"testFindRawBatchesMatchesFind"*, *"testFindRawBatchesReturnsTheSameDocuments"*.
- A dropped response closes the cursor and stops the prefetch thread, including through the endpoints' `streamRawJsonArray(prefetchedBatches(...))`: *"testClosingEarlyClosesTheCursor"*, *"testClosingEarlyThroughPrefetchStopsTheThread"*, *"testClosingEarlyStopsTheThreadAndClosesTheCursor"*.

Process: `tox -e native` builds the crate and runs these tests on the native path, with `NIMBUS_REQUIRE_NATIVE_JSON=1` so a wheel that fails to import fails the tests instead of skipping them. After editing the crate, use `tox -r -e native`: tox doesn't rebuild a path dependency. The default `tox -e py311` runs the same tests on the Python fallback. The Docker build imports the module after installing the wheel, so an unusable wheel fails the image build. An orjson upgrade that changes float or escape formatting fails the native env rather than silently changing responses. To prove a parity test can fail, mutate the crate (e.g. drop the `+` in `write_f64`), `pip install --force-reinstall --no-deps ./bson-json-native` into `.tox/native`, and run the tests again.

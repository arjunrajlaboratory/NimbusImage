"""Live verification of server-side gating (SERVER_GATING.md) against a real
over-cap dataset — by default the 708,983-object Xenium morphology dataset on
the local dev stack.

Unit tests cannot catch a wrong Mongo projection, a route that isn't
registered, or a resolution that disagrees with the list query at scale; this
script asserts all three end to end and prints the timings the spec quotes.

    python3 -m venv .venv && . .venv/bin/activate
    pip install -e nimbusimage
    python devops/girder/plugins/AnnotationPlugin/scripts/\
verify_server_gating.py

Override the target with GIRDER_API_URL / GIRDER_USERNAME / GIRDER_PASSWORD
and NIMBUS_GATING_DATASET_ID. Read-only: it creates and modifies nothing.
"""
import json
import os
import time

from nimbusimage._girder import create_client

# Local dev defaults (CLAUDE.md); override via env if set.
gc = create_client(
    api_url=os.environ.get("GIRDER_API_URL", "http://localhost:8080/api/v1"),
    username=os.environ.get("GIRDER_USERNAME", "admin"),
    password=os.environ.get("GIRDER_PASSWORD", "password"),
)

DS = os.environ.get(
    "NIMBUS_GATING_DATASET_ID", "6a19784f247013c971283206"
)  # default: morphology, 708,983 objects
EXPECTED_TOTAL = int(os.environ.get("NIMBUS_GATING_TOTAL", "708983"))
CELL_KEY = 'v1:["cell"]'
CH0_KEY = "v1:0"


def timed(label, fn):
    start = time.time()
    result = fn()
    print(f"{label}: {time.time() - start:.2f}s")
    return result


# 1. Gate over tags x channel — one category each, so a box around (0,0)
#    should select the whole dataset.
plot = {
    "id": "plot-1",
    "xAxis": {"type": "categorical", "key": "tags"},
    "yAxis": {"type": "categorical", "key": "channel"},
    "gate": {
        "categoryKeyVersion": 1,
        "vertices": [
            {"x": -0.4, "y": -0.4}, {"x": 0.4, "y": -0.4},
            {"x": 0.4, "y": 0.4}, {"x": -0.4, "y": 0.4},
        ],
        "xCategories": [CELL_KEY],
        "yCategories": [CH0_KEY],
    },
}
res = timed("gate_ids (whole-dataset box)", lambda: gc.post(
    "/upenn_annotation/analysis/gate_ids",
    json={"datasetId": DS, "plots": [plot]},
))
count = len(res["gateIds"]["plot-1"])
print(f"  -> {count:,} ids (expect {EXPECTED_TOTAL:,})")
assert count == EXPECTED_TOTAL, count

# 2. A narrow slice of the jittered strip: must be a strict, stable subset.
narrow = json.loads(json.dumps(plot))
narrow["id"] = "narrow"
narrow["gate"]["vertices"] = [
    {"x": -0.28, "y": -0.4}, {"x": -0.1, "y": -0.4},
    {"x": -0.1, "y": 0.4}, {"x": -0.28, "y": 0.4},
]
res2 = timed("gate_ids (narrow jitter slice)", lambda: gc.post(
    "/upenn_annotation/analysis/gate_ids",
    json={"datasetId": DS, "plots": [narrow]},
))
narrow_ids = res2["gateIds"]["narrow"]
print(f"  -> {len(narrow_ids):,} ids (expect a partial slice)")
assert 0 < len(narrow_ids) < EXPECTED_TOTAL
# Determinism: the same request must return the same set.
again = gc.post("/upenn_annotation/analysis/gate_ids",
                json={"datasetId": DS, "plots": [narrow]})
assert again["gateIds"]["narrow"] == narrow_ids, "gate resolution not stable"
print("  -> stable across repeated requests")

# 3. Histogram over the same axes.
hist = timed("histogram2d", lambda: gc.post(
    "/upenn_annotation/analysis/histogram2d",
    json={
        "datasetId": DS,
        "xAxis": {"type": "categorical", "key": "tags"},
        "yAxis": {"type": "categorical", "key": "channel"},
        "xCategories": [CELL_KEY], "yCategories": [CH0_KEY],
        "bins": {"x": 128, "y": 128},
        "upstreamGates": [], "filters": {},
        "gate": narrow["gate"],
    },
))
print(f"  -> inputCount={hist['inputCount']:,} "
      f"plotted={hist['plottedCount']:,} gateCount={hist['gateCount']:,}")
assert hist["inputCount"] == EXPECTED_TOTAL
assert hist["gateCount"] == len(narrow_ids), (
    f"histogram badge {hist['gateCount']} != gate_ids {len(narrow_ids)}"
)
print("  -> badge count agrees with gate_ids resolution")

# 4. A numeric axis on a dataset with no property values: everything is
#    missing, so the gate must match nothing (not error).
numeric = {
    "id": "numeric",
    "xAxis": {"type": "property", "path": ["nosuch", "Area"]},
    "yAxis": {"type": "property", "path": ["nosuch", "Mean"]},
    "gate": {
        "categoryKeyVersion": 1,
        "vertices": [
            {"x": -1e9, "y": -1e9}, {"x": 1e9, "y": -1e9},
            {"x": 1e9, "y": 1e9}, {"x": -1e9, "y": 1e9},
        ],
        "xCategories": None, "yCategories": None,
    },
}
res3 = timed("gate_ids (property axes, no values)", lambda: gc.post(
    "/upenn_annotation/analysis/gate_ids",
    json={"datasetId": DS, "plots": [numeric]},
))
assert res3["gateIds"]["numeric"] == []
print("  -> empty (missing values are outside every gate)")

# 5. Phase 3: the same gate as a LIST filter term must agree with gate_ids.
ids_resp = timed("list/ids with gate definition", lambda: gc.post(
    "/upenn_annotation/list/ids",
    json={
        "datasetId": DS,
        "filters": {"analysisGates": [{
            "xAxis": narrow["xAxis"], "yAxis": narrow["yAxis"],
            "gate": narrow["gate"],
        }]},
    },
))
print(f"  -> total={ids_resp['total']:,}")
assert ids_resp["total"] == len(narrow_ids), (
    f"list {ids_resp['total']} != gate_ids {len(narrow_ids)}"
)
assert sorted(ids_resp["ids"]) == sorted(narrow_ids)
print("  -> list query and gate_ids agree exactly")

# 6. A gate composed with a tag filter, through the list page endpoint.
page = timed("list page with gate + tag filter", lambda: gc.post(
    "/upenn_annotation/list",
    json={
        "datasetId": DS,
        "filters": {
            "tags": {"values": ["cell"], "exclusive": False},
            "analysisGates": [{
                "xAxis": narrow["xAxis"], "yAxis": narrow["yAxis"],
                "gate": narrow["gate"],
            }],
        },
        "sort": None, "propertyPaths": [], "offset": 0, "limit": 5,
    },
))
print(f"  -> total={page['total']:,} rows={len(page['rows'])}")
assert page["total"] == len(narrow_ids)

print("\nALL LIVE CHECKS PASSED")

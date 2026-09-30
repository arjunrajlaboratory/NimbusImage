"""Live end-to-end verification of ``nimbusimage.xenium``.

Not a pytest module (no ``test_`` prefix): it runs the real
``nimbusimage-xenium`` CLI against a live NimbusImage backend and checks
every stored result against the bundles, so it needs data and a server CI
does not have. Run it before merging changes to the Xenium ingest; see
``codebaseDocumentation/XENIUM_INGEST.md`` ("Live verification").

What it does, and what "PASS" means:

1. For every extracted bundle directory under ``XENIUM_LIVE_BUNDLES``: the
   whole pipeline (morphology, a test slice removed with --delete-tag,
   polygons, UMAP, properties, cell types, spatial table, transcripts,
   regions) on a fresh dataset, plus an H&E-like second dataset drawn with
   a synthetic alignment. Every property value, table column, molecule
   count, transform and region vertex is compared with the bundle; server
   state is read back from MongoDB and the REST API, never from logs.
2. Every bug class found in review, reproduced live: each must exit
   non-zero with a clean ``error:`` line AND leave the server unchanged
   (annotation, property-value and item counts, transcript registration).
3. Spatial tables go only to their own dataset, including a real
   SpatialPlugin recompute version (provenance in ``uns.attrs``).
4. Optional, read-only: the geometry match on a large real H&E dataset
   equals its original id file.

Environment:

    NI_API_URL          default http://localhost:8080/api/v1
    NI_TEST_USER        default admin
    NI_TEST_PASS        default password
    XENIUM_LIVE_BUNDLES required: directory holding extracted bundles
                        (each with cells.zarr.zip, transcripts.zarr.zip,
                        morphology_focus/, ...); 10x "tiny" bundles are
                        enough and run in ~2 minutes
    XENIUM_LIVE_CLI     default: nimbusimage-xenium on PATH
    XENIUM_LIVE_MONGO   default nimbusimage-mongodb-1 (docker container)
    XENIUM_LIVE_WORK    default: a new temporary directory
    XENIUM_LIVE_BIG_BUNDLE, XENIUM_LIVE_BIG_DATASET,
    XENIUM_LIVE_BIG_ALIGNMENT, XENIUM_LIVE_BIG_IDS
                        optional (all four): a large bundle, its H&E
                        dataset id, its alignment csv and the id .npy its
                        polygons were uploaded with; read-only check

Run from outside the repository root (the ``nimbusimage/`` folder there
shadows the installed package)::

    XENIUM_LIVE_BUNDLES=~/Downloads/xenium-tiny \
        python /path/to/nimbusimage/tests/integration/xenium_live.py

It creates datasets named ``live e2e <bundle> <time>`` and leaves them.
Exit status 0 only if every check passed.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import numpy as np

import nimbusimage as ni
from nimbusimage.xenium import (
    CellMap,
    ImageFrame,
    XeniumBundle,
    XeniumError,
    fetch_cells,
)
from nimbusimage.xenium.bundle import open_zarr_zip

API_URL = os.environ.get("NI_API_URL", "http://localhost:8080/api/v1")
USER = os.environ.get("NI_TEST_USER", "admin")
PASSWORD = os.environ.get("NI_TEST_PASS", "password")
CLI = os.environ.get("XENIUM_LIVE_CLI") or shutil.which("nimbusimage-xenium")
MONGO_CONTAINER = os.environ.get("XENIUM_LIVE_MONGO", "nimbusimage-mongodb-1")
ENV = dict(
    os.environ, NI_API_URL=API_URL, NI_USERNAME=USER, NI_PASSWORD=PASSWORD
)
ENV.pop("NI_API_KEY", None)
ENV.pop("NI_TOKEN", None)
RUN = time.strftime("%H%M%S")
RESULTS = []
client = None


def check(name, ok, detail=""):
    RESULTS.append((name, bool(ok), detail))
    print(f"  {'PASS' if ok else 'FAIL'}  {name}  {detail}", flush=True)


def run(*args, expect_ok=True):
    r = subprocess.run(
        [CLI, *map(str, args)],
        env=ENV,
        capture_output=True,
        text=True,
        timeout=1800,
    )
    if expect_ok and r.returncode != 0:
        raise RuntimeError(f"{args[0]} failed: {r.stderr[-800:]}")
    return r


def mongo(js):
    out = subprocess.run(
        [
            "docker",
            "exec",
            MONGO_CONTAINER,
            "mongosh",
            "girder",
            "--quiet",
            "--eval",
            js,
        ],
        capture_output=True,
        text=True,
        timeout=300,
    )
    return out.stdout.strip()


def values_of(dataset_id):
    raw = mongo(
        f"print(JSON.stringify(db.annotation_property_values.find("
        f"{{datasetId:ObjectId('{dataset_id}')}}).toArray().map(d=>"
        f"[String(d.annotationId), d.values])))"
    )
    merged = {}
    for ann, vals in json.loads(raw):
        merged.setdefault(ann, {}).update(vals)
    return merged


def encode_cell_id(prefix) -> str:
    """The inverse of decode_cell_id: 8 nibbles as letters a..p."""
    return "".join(
        chr(ord("a") + ((int(prefix) >> (4 * (7 - k))) & 15))
        for k in range(8)
    )


def cell_types_csv(bundle, path):
    """A cell-types CSV from the bundle's first clustering (the tiny bundles
    ship none), written in reverse order to exercise the id join."""
    packed = open_zarr_zip(bundle.cells_zarr)["cell_id"][:]
    groups = bundle.cell_groups()
    label = next(iter(groups.values()))
    rows = [
        f"{encode_cell_id(p)}-{s},Type {label[i]}"
        for i, (p, s) in enumerate(packed)
    ]
    path.write_text("cell_id,group\n" + "\n".join(rows[::-1]) + "\n")
    return [f"Type {label[i]}" for i in range(len(packed))]


def pipeline(bundle_dir, work):
    bundle = XeniumBundle(bundle_dir)
    name = bundle.directory.name
    print(
        f"\n=== {name}: {bundle.number_of_cells} cells, "
        f"pixel {bundle.pixel_size} ===",
        flush=True,
    )
    labels = cell_types_csv(bundle, work / "types.csv")
    csc, symbols, _, kinds = bundle.counts()
    dense = csc.toarray()
    genes = [s for s, k in zip(symbols, kinds) if k == "gene"]
    names = bundle.features()[2]
    panel = [
        genes[int(i)] for i in np.argsort(-dense[:, : len(genes)].sum(0))[:3]
    ]
    dotted = [n for n in names if "." in n]
    if dotted:  # use the bundle's own dotted name, as a user would
        panel.append(dotted[0])

    ds_id = run(
        "morphology",
        "--bundle-dir",
        bundle_dir,
        "--name",
        f"live e2e {name} {RUN}",
    ).stdout.strip()
    ds = client.dataset(ds_id)
    cells_path = work / "cells.npz"
    # test slice + delete-tag, then the full upload
    run(
        "polygons",
        "--bundle-dir",
        bundle_dir,
        "--dataset",
        ds_id,
        "--limit",
        "5",
        "--tags",
        "slice",
    )
    run(
        "polygons",
        "--bundle-dir",
        bundle_dir,
        "--dataset",
        ds_id,
        "--delete-tag",
        "slice",
        "--cells-out",
        cells_path,
    )
    cells = CellMap.read(cells_path)
    n_poly = ds.annotations.count(shape="polygon")
    check(
        "polygons: slice removed, one annotation per non-degenerate cell",
        n_poly == cells.count() and not ds.annotations.list(tags=["slice"]),
        f"{n_poly} polygons / {cells.count()} mapped",
    )
    check(
        "cell map re-derived by geometry equals the saved map",
        fetch_cells(ds, bundle, cells.frame).ids.tolist()
        == cells.ids.tolist(),
    )

    run(
        "umap",
        "--bundle-dir",
        bundle_dir,
        "--out",
        work / "umap",
        "--n-neighbors",
        str(min(10, bundle.number_of_cells - 1)),
    )
    run(
        "properties",
        "--bundle-dir",
        bundle_dir,
        "--dataset",
        ds_id,
        "--cells",
        cells_path,
        "--what",
        "genes,clusters,umap",
        "--genes",
        ",".join(panel),
        "--umap",
        work / "umap/umap_xy.npy",
    )
    run(
        "cell-types",
        "--bundle-dir",
        bundle_dir,
        "--dataset",
        ds_id,
        "--cells",
        cells_path,
        "--cell-types",
        work / "types.csv",
    )

    # every stored value against the bundle
    stored = values_of(ds_id)
    pos = {a: i for i, a in enumerate(cells.ids) if a}
    groups = bundle.cell_groups()
    umap = np.load(work / "umap/umap_xy.npy")
    from nimbusimage.xenium.bundle import safe_symbol

    col = {safe_symbol(s): symbols.index(safe_symbol(s)) for s in panel}
    bad = 0
    for ann, vals in stored.items():
        i = pos[ann]
        for v in vals.values():
            if set(col) <= set(v):
                bad += any(v[g] != dense[i, col[g]] for g in col)
            elif "x" in v:
                bad += not np.allclose([v["x"], v["y"]], umap[i], atol=1e-5)
            else:
                bad += any(v[k] != int(groups[k][i]) for k in v)
    check(
        "property values match the bundle (genes, clusterings, UMAP)",
        len(stored) == cells.count() and bad == 0,
        f"{len(stored)} cells, {bad} mismatches",
    )
    tags = {a.id: a.tags for a in ds.annotations.list(tags=["cell"])}
    check(
        "cell-type tags match the CSV (joined on decoded cell id)",
        all(tags[cells.ids[i]] == ["cell", labels[i]] for i in pos.values()),
    )

    run(
        "spatial-table",
        "--bundle-dir",
        bundle_dir,
        "--dataset",
        ds_id,
        "--cells",
        cells_path,
        "--cell-types",
        work / "types.csv",
        "--umap",
        work / "umap/umap_xy.npy",
        "--out",
        work / "t.zarr.zip",
    )
    info = ds.spatial.info(verify=True)
    check(
        "spatial table registered; every row joins to an annotation",
        info["nObs"] == cells.count() == info["liveAnnotations"]
        and info["nVar"] == len(symbols),
        f"nObs {info['nObs']}, nVar {info['nVar']}",
    )
    wrong = 0
    for s in (
        list(col) + [s for s, k in zip(symbols, kinds) if k == "protein"][:2]
    ):
        column = ds.spatial.column(s)
        got = np.zeros(len(cells.ids))
        for a, v in zip(column["annotationIds"], column["values"]):
            got[pos[a]] = v
        mask = np.array([i is not None for i in cells.ids])
        wrong += not np.allclose(got[mask], dense[mask, symbols.index(s)])
    check("table columns (genes and proteins) match the bundle", wrong == 0)

    run(
        "transcripts",
        "--bundle-dir",
        bundle_dir,
        "--dataset",
        ds_id,
        "--cells",
        cells_path,
    )
    tx = ds.spatial.transcripts()
    zattrs = open_zarr_zip(bundle.transcripts_zarr).attrs
    check(
        "transcripts registered: molecule count = zarr, morphology frame",
        tx["totalPoints"] == zattrs["number_rnas"]
        and tx.get("transform") is None
        and tx["pixelSize"] == bundle.pixel_size,
        f"{tx['totalPoints']:,} molecules",
    )

    # regions: H&E-drawn onto morphology (adds M), microns, custom tag
    M = np.array([[2.0, 0, 10], [0, 2.0, 20], [0, 0, 1]])
    np.savetxt(work / "M.csv", M, delimiter=",")
    (work / "he.json").write_text(
        json.dumps(
            {
                "features": [
                    {
                        "properties": {"name": "HEregion"},
                        "geometry": {
                            "type": "Polygon",
                            "coordinates": [[[0, 0], [100, 0], [100, 100]]],
                        },
                    }
                ]
            }
        )
    )
    run(
        "regions",
        "--geojson",
        work / "he.json",
        "--dataset",
        ds_id,
        "--cells",
        cells_path,
        "--drawn-in",
        "he",
        "--alignment",
        work / "M.csv",
        "--tag",
        "pathology",
    )
    [region] = ds.annotations.list(tags=["pathology"])
    check(
        "regions: H&E-drawn region carried by M onto morphology, "
        "'region' kept with a custom tag",
        np.allclose(
            [region.coordinates[1]["x"], region.coordinates[1]["y"]],
            (M @ [100, 0, 1])[:2],
        )
        and region.tags == ["HEregion", "pathology", "region"],
    )

    # H&E-like dataset: same image, synthetic alignment
    he_id = run(
        "morphology",
        "--bundle-dir",
        bundle_dir,
        "--name",
        f"live e2e {name} (H&E-like) {RUN}",
    ).stdout.strip()
    he = client.dataset(he_id)
    he_cells = work / "cells_he.npz"
    run(
        "polygons",
        "--bundle-dir",
        bundle_dir,
        "--dataset",
        he_id,
        "--alignment",
        work / "M.csv",
        "--cells-out",
        he_cells,
    )
    hc = CellMap.read(he_cells)
    first = he.annotations.get_many([hc.ids[hc.indices()[0]]])[0]
    exp = np.linalg.inv(M) @ [
        *(bundle.first_vertices([hc.indices()[0]])[0] / bundle.pixel_size),
        1,
    ]
    check(
        "H&E polygons drawn through M^-1",
        np.allclose(
            [first.coordinates[0]["x"], first.coordinates[0]["y"]],
            exp[:2],
            atol=1e-3,
        ),
    )
    run(
        "transcripts",
        "--bundle-dir",
        bundle_dir,
        "--dataset",
        he_id,
        "--cells",
        he_cells,
    )
    check(
        "H&E transcripts transform = M^-1 (from the saved frame)",
        np.allclose(
            np.array(he.spatial.transcripts()["transform"]), np.linalg.inv(M)
        ),
    )
    run(
        "regions",
        "--geojson",
        work / "he.json",
        "--dataset",
        he_id,
        "--cells",
        he_cells,
        "--drawn-in",
        "he",
    )
    [he_region] = he.annotations.list(tags=["region"])
    check(
        "H&E-drawn regions on the H&E dataset are unchanged",
        he_region.coordinates[1] == {"x": 100.0, "y": 0.0},
    )
    return bundle, ds, he, cells_path, he_cells


def snapshot(*datasets):
    counts = []
    for d in datasets:
        counts.append(
            (
                mongo(
                    f"print(db.upenn_annotation.countDocuments({{datasetId:"
                    f"ObjectId('{d.id}')}}))"
                ),
                mongo(
                    f"print(db.annotation_property_values.countDocuments("
                    f"{{datasetId:ObjectId('{d.id}')}}))"
                ),
                mongo(
                    f"print(db.item.countDocuments({{folderId:"
                    f"ObjectId('{d.id}')}}))"
                ),
                json.dumps(
                    d.spatial.transcripts(), sort_keys=True, default=str
                ),
            )
        )
    return counts


def refusals(bundle_dir, ds, he, cells_path, he_cells, work):
    """Every bug found across the review rounds, reproduced live: each
    must exit 1 with a clean error and change nothing on the server."""
    b = str(bundle_dir)
    np.savetxt(work / "singular.csv", np.zeros((3, 3)), delimiter=",")
    np.save(work / "legacy_he_ids.npy", CellMap.read(he_cells).ids)
    nuclei = work / "nuclei.npz"
    CellMap(
        ds.id,
        CellMap.read(cells_path).frame,
        CellMap.read(cells_path).ids,
        "nucleus",
    ).save(nuclei)
    ds.annotations.create_many(
        [
            ni.Annotation(
                shape="polygon",
                tags=["keepme"],
                channel=0,
                dataset_id=ds.id,
                coordinates=[
                    {"x": 1, "y": 1},
                    {"x": 5, "y": 1},
                    {"x": 5, "y": 5},
                ],
                location=ni.Location(xy=0, z=0, time=0),
            )
        ]
    )
    cases = [
        (
            "R1 polygons --delete-tag with a bad alignment keeps the tagged",
            [
                "polygons",
                "--bundle-dir",
                b,
                "--dataset",
                ds.id,
                "--delete-tag",
                "keepme",
                "--alignment",
                work / "nope.csv",
            ],
        ),
        (
            "R1 transcripts with a singular alignment: no upload",
            [
                "transcripts",
                "--bundle-dir",
                b,
                "--dataset",
                he.id,
                "--alignment",
                work / "singular.csv",
            ],
        ),
        (
            "R1 properties with an unknown gene: no id fetch, no write",
            [
                "properties",
                "--bundle-dir",
                b,
                "--dataset",
                ds.id,
                "--cells",
                cells_path,
                "--genes",
                "NOTAGENE",
            ],
        ),
        (
            "R2 H&E dataset's cell map used on the morphology dataset",
            [
                "cell-types",
                "--bundle-dir",
                b,
                "--dataset",
                ds.id,
                "--cells",
                he_cells,
                "--cell-types",
                work / "types.csv",
            ],
        ),
        (
            "R2 legacy bare ids of the H&E dataset used on morphology",
            [
                "properties",
                "--bundle-dir",
                b,
                "--dataset",
                ds.id,
                "--cells",
                work / "legacy_he_ids.npy",
                "--what",
                "clusters",
            ],
        ),
        (
            "R2 empty --what",
            [
                "properties",
                "--bundle-dir",
                b,
                "--dataset",
                ds.id,
                "--cells",
                cells_path,
                "--what",
                ",",
            ],
        ),
        (
            "R3 nucleus cell map for per-cell data",
            [
                "properties",
                "--bundle-dir",
                b,
                "--dataset",
                ds.id,
                "--cells",
                nuclei,
                "--what",
                "clusters",
            ],
        ),
        (
            "R4 --pixel-size conflicting with the saved frame",
            [
                "properties",
                "--bundle-dir",
                b,
                "--dataset",
                ds.id,
                "--cells",
                cells_path,
                "--pixel-size",
                "0.3",
                "--what",
                "clusters",
            ],
        ),
        (
            "R5 transcripts with no frame stated",
            ["transcripts", "--bundle-dir", b, "--dataset", he.id],
        ),
        (
            "R5 transcripts with a mistyped --cells",
            [
                "transcripts",
                "--bundle-dir",
                b,
                "--dataset",
                he.id,
                "--cells",
                work / "cells_hee.npz",
            ],
        ),
        (
            "R5 transcripts with a bare-id file as the frame",
            [
                "transcripts",
                "--bundle-dir",
                b,
                "--dataset",
                he.id,
                "--cells",
                work / "legacy_he_ids.npy",
            ],
        ),
        (
            "R6 regions --alignment with no --image or --cells",
            [
                "regions",
                "--geojson",
                work / "he.json",
                "--dataset",
                ds.id,
                "--drawn-in",
                "he",
                "--alignment",
                work / "M.csv",
            ],
        ),
        (
            "R8 regions --pixel-size with no --image or --cells",
            [
                "regions",
                "--geojson",
                work / "he.json",
                "--dataset",
                he.id,
                "--drawn-in",
                "microns",
                "--pixel-size",
                "0.2125",
            ],
        ),
        (
            "R8 regions with an empty tag",
            [
                "regions",
                "--geojson",
                work / "he.json",
                "--dataset",
                ds.id,
                "--cells",
                cells_path,
                "--drawn-in",
                "morphology",
                "--tag",
                "",
            ],
        ),
        (
            "R5 --limit 0 / --chunk 0",
            [
                "properties",
                "--bundle-dir",
                b,
                "--dataset",
                ds.id,
                "--cells",
                cells_path,
                "--what",
                "clusters",
                "--chunk",
                "0",
            ],
        ),
    ]
    for name, argv in cases:
        before = snapshot(ds, he)
        r = run(*argv, expect_ok=False)
        after = snapshot(ds, he)
        clean = r.returncode != 0 and "Traceback" not in r.stderr
        check(
            name,
            clean and before == after,
            (r.stderr.strip().splitlines() or ["(no output)"])[-1][:110],
        )
    check(
        "R1 the tagged annotations survived",
        len(ds.annotations.list(tags=["keepme"])) == 1,
    )


def tables(ds, he, work):
    """R5/R7: tables go only to the dataset they record — including a real
    recompute version written by the SpatialPlugin (uns.attrs)."""
    from nimbusimage.xenium import upload_spatial_table

    try:
        upload_spatial_table(he, work / "t.zarr.zip")
        check("R5 morphology table refused on the H&E dataset", False)
    except XeniumError as exc:
        check(
            "R5 morphology table refused on the H&E dataset",
            True,
            str(exc)[:90],
        )
    result = ds.spatial.recompute("live-v2", scope="all")
    versions = ds.spatial.versions()
    item_id = versions["active"]["itemId"]
    files = list(client.girder.listFile(item_id))
    path = work / "recomputed.zarr.zip"
    client.girder.downloadFile(files[0]["_id"], str(path))
    from nimbusimage.xenium import spatial_table_dataset

    check(
        "R7 a real recompute version records its dataset (uns.attrs)",
        spatial_table_dataset(path) == ds.id,
        f"{result}"[:80],
    )
    try:
        upload_spatial_table(he, path)
        check("R7 recomputed table refused on another dataset", False)
    except XeniumError:
        check("R7 recomputed table refused on another dataset", True)


def big_dataset_check():
    names = ("BUNDLE", "DATASET", "ALIGNMENT", "IDS")
    values = [os.environ.get(f"XENIUM_LIVE_BIG_{n}") for n in names]
    if not all(values):
        print("\n(skipping the large-dataset check: set XENIUM_LIVE_BIG_*)")
        return
    bundle_dir, dataset_id, alignment, ids_path = values
    print("\n=== large real H&E dataset (read-only) ===", flush=True)
    bundle = XeniumBundle(bundle_dir)
    frame = ImageFrame.create(bundle=bundle, alignment=alignment)
    fetched = fetch_cells(client.dataset(dataset_id), bundle, frame)
    original = np.load(ids_path, allow_pickle=True)
    check(
        "geometry match on real cells equals the original ids",
        fetched.ids.tolist() == original.tolist(),
        f"{fetched.count():,} cells",
    )


def main():
    global client
    bundles_dir = os.environ.get("XENIUM_LIVE_BUNDLES")
    if not bundles_dir:
        sys.exit("set XENIUM_LIVE_BUNDLES to a directory of extracted bundles")
    if not CLI:
        sys.exit("nimbusimage-xenium not found; set XENIUM_LIVE_CLI")
    client = ni.connect(API_URL, username=USER, password=PASSWORD)
    work_root = Path(
        os.environ.get("XENIUM_LIVE_WORK") or tempfile.mkdtemp("xenium-live")
    )
    work_root.mkdir(parents=True, exist_ok=True)
    bundles = sorted(p for p in Path(bundles_dir).iterdir() if p.is_dir())
    last = None
    for bundle_dir in bundles:
        work = Path(tempfile.mkdtemp(prefix="live-", dir=work_root))
        try:
            last = (bundle_dir, work, *pipeline(bundle_dir, work))
        except Exception as exc:  # report, then go on to the next bundle
            check(f"pipeline on {bundle_dir.name}", False, repr(exc)[:300])
    if last is None:
        sys.exit("no bundle completed the pipeline; nothing to test further")
    bundle_dir, work, bundle, ds, he, cells_path, he_cells = last
    print(f"\n=== regressions, live, on {bundle_dir.name} ===", flush=True)
    refusals(bundle_dir, ds, he, cells_path, he_cells, work)
    tables(ds, he, work)
    big_dataset_check()

    failed = [r for r in RESULTS if not r[1]]
    print(f"\n{len(RESULTS) - len(failed)}/{len(RESULTS)} checks passed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()

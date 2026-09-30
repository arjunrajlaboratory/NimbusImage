"""Tests for nimbusimage.xenium against a synthetic four-cell bundle.

Two kinds of tests: behaviour of each piece, and CONTRACT tables that
state the package's invariants across every step and input at once —

- every per-cell step refuses a cell map of another dataset, of nuclei,
  of another bundle, or bare ids, before writing anything;
- every CLI subcommand, given a bad input, exits non-zero with zero server
  writes, while its valid baseline run succeeds (so a variant can't pass
  for the wrong reason).

Review rounds on this package kept finding one instance of those
invariants at a time; the tables hold them for every step and input.
"""

import json
import zipfile
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

zarr = pytest.importorskip("zarr")

from nimbusimage.xenium import (  # noqa: E402
    PROTEIN_SUFFIX,
    CellMap,
    ImageFrame,
    XeniumBundle,
    XeniumError,
    build_spatial_table,
    decode_cell_id,
    fetch_cells,
    open_cells,
    region_annotations,
    register_transcripts,
    upload_cell_types,
    upload_clusters,
    upload_gene_panel,
    upload_polygons,
    upload_regions,
    upload_spatial_table,
    upload_umap,
)
from nimbusimage.xenium.bundle import (  # noqa: E402
    ome_channel_names,
    staged_channel_file_name,
)
from nimbusimage.xenium.cli import main as cli_main  # noqa: E402

PIXEL_SIZE = 0.5
# Cell 2 is degenerate (two vertices): the polygon upload skips it.
CELL_VERTICES = [
    [(0, 0), (4, 0), (4, 4), (0, 4)],
    [(10, 10), (14, 10), (14, 14)],
    [(20, 20), (21, 21)],
    [(30, 30), (34, 30), (34, 34), (30, 34), (32, 36)],
]
# Nuclei sit inside their cells: a distinct first vertex, so nucleus ids
# can't pass as cell ids.
NUCLEUS_VERTICES = [
    [(x + 1, y + 1) for x, y in polygon] for polygon in CELL_VERTICES
]
CELL_IDS = ["aaaaaaaa-1", "aaaaaaab-1", "aaaaaaba-1", "aaaaaabb-1"]
# feature x cell counts (gene-major, like the 10x matrix)
FEATURES = [
    ("GENEA", "gene", [3, 0, 1, 0]),
    ("NegCtrl", "negative_control_probe", [1, 1, 1, 1]),
    # The protein row comes FIRST: a lookup by name alone would find it and
    # reject the gene CD3E as "not a gene".
    ("CD3E", "protein", [7, 0, 0, 9]),
    ("CD3E", "gene", [0, 5, 0, 2]),
]
CELL_TYPES = ["T cell", "B cell", "T cell", "Macrophage"]


def _write_zarr_zip(path: Path, build) -> None:
    """Build a zarr group on disk, then zip it with entries at the root."""
    directory = path.with_suffix(".dir")
    build(zarr.open_group(str(directory), mode="w"))
    with zipfile.ZipFile(path, "w") as zf:
        for file in sorted(directory.rglob("*")):
            if file.is_file():
                zf.write(file, file.relative_to(directory).as_posix())


def _array(group, name, data):
    """zarr 3 ``create_array`` / zarr 2 ``create_dataset``."""
    if hasattr(group, "create_array"):
        return group.create_array(name, data=data)
    return group.create_dataset(name, data=data)


def _polygon_arrays(polygons):
    max_vertices = max(len(p) for p in polygons)
    vertices = np.zeros((len(polygons), 2 * max_vertices), dtype=np.float32)
    for i, polygon in enumerate(polygons):
        vertices[i, : 2 * len(polygon)] = np.asarray(polygon).ravel()
    return np.array([len(p) for p in polygons], dtype=np.int32), vertices


@pytest.fixture
def bundle(tmp_path) -> XeniumBundle:
    (tmp_path / "experiment.xenium").write_text(
        json.dumps({"pixel_size": PIXEL_SIZE})
    )

    def cells(group):
        group.attrs["number_cells"] = len(CELL_VERTICES)
        group.attrs["polygon_set_names"] = ["nucleus", "cell"]
        sets = group.create_group("polygon_sets")
        for index, polygons in enumerate([NUCLEUS_VERTICES, CELL_VERTICES]):
            n_vertices, vertices = _polygon_arrays(polygons)
            polygon_set = sets.create_group(str(index))
            _array(polygon_set, "num_vertices", n_vertices)
            _array(polygon_set, "vertices", vertices)
        packed = np.array(
            [decode_cell_id(c) for c in CELL_IDS], dtype=np.uint32
        )
        _array(group, "cell_id", packed)

    def matrix(group):
        features = group.create_group("cell_features")
        features.attrs["feature_keys"] = [f[0] for f in FEATURES]
        features.attrs["feature_types"] = [f[1] for f in FEATURES]
        features.attrs["feature_ids"] = [
            f"ID{i}" for i in range(len(FEATURES))
        ]
        features.attrs["number_features"] = len(FEATURES)
        features.attrs["number_cells"] = len(CELL_VERTICES)
        data, indices, indptr = [], [], [0]
        for _, _, counts in FEATURES:
            for cell, value in enumerate(counts):
                if value:
                    data.append(value)
                    indices.append(cell)
            indptr.append(len(data))
        _array(features, "data", np.array(data, dtype=np.uint32))
        _array(features, "indices", np.array(indices, dtype=np.uint32))
        _array(features, "indptr", np.array(indptr, dtype=np.uint32))

    def analysis(group):
        groups = group.create_group("cell_groups")
        groups.attrs["grouping_names"] = ["gene_expression_graphclust"]
        # cluster 1 = cells {0, 2}; cluster 2 = cell {1} + one padding zero;
        # cell 3 unassigned. Naive decoding gives cell 0 cluster 2.
        grouping = groups.create_group("0")
        _array(grouping, "indices", np.array([0, 2, 1, 0], dtype=np.uint32))
        _array(grouping, "indptr", np.array([0, 2], dtype=np.uint32))

    _write_zarr_zip(tmp_path / "cells.zarr.zip", cells)
    _write_zarr_zip(tmp_path / "cell_feature_matrix.zarr.zip", matrix)
    _write_zarr_zip(tmp_path / "analysis.zarr.zip", analysis)
    rows = ["cell_id,group"] + [
        f"{c},{t}" for c, t in reversed(list(zip(CELL_IDS, CELL_TYPES)))
    ]
    (tmp_path / "cell_types.csv").write_text("\n".join(rows) + "\n")
    (tmp_path / "transcripts.zarr.zip").write_bytes(b"shipped as-is")
    return XeniumBundle(tmp_path)


def _expected_first_vertex(cell: int) -> tuple[float, float]:
    x, y = CELL_VERTICES[cell][0]
    return x / PIXEL_SIZE, y / PIXEL_SIZE


def pathlib_touch(path):
    """Module-level so a pickle can reference it (test payload only)."""
    Path(path).touch()


# --- an in-memory server that records every write ---


class FakeServer:
    """Annotations per dataset, dataset-scoped reads, and a log of writes."""

    def __init__(self):
        self.annotations = {}  # id -> SimpleNamespace, in creation order
        self.values = {}  # property id -> {annotation id: value}
        self.writes = []  # (dataset id, method)
        self.datasets = {}

    def dataset(self, dataset_id):
        if dataset_id not in self.datasets:
            self.datasets[dataset_id] = FakeDataset(self, dataset_id)
        return self.datasets[dataset_id]

    def write(self, dataset_id, method):
        self.writes.append((dataset_id, method))


class FakeAnnotations:
    def __init__(self, server, dataset_id):
        self._server, self._id = server, dataset_id

    def _mine(self):
        return [
            a
            for a in self._server.annotations.values()
            if a.dataset_id == self._id
        ]

    def create_many(self, annotations):
        self._server.write(self._id, "create_many")
        made = []
        for annotation in annotations:
            new = SimpleNamespace(
                id=f"ann_{len(self._server.annotations)}",
                dataset_id=self._id,
                coordinates=annotation.coordinates,
                tags=list(annotation.tags),
                shape=annotation.shape,
            )
            self._server.annotations[new.id] = new
            made.append(new)
        return made

    def list(self, shape=None, tags=None, limit=0, offset=0):
        # Like the server: tags match with $all.
        found = [
            a
            for a in self._mine()
            if (shape is None or a.shape == shape)
            and (not tags or set(tags) <= set(a.tags))
        ]
        return found[offset:offset + limit] if limit else found[offset:]

    def iter_all(self, shape=None, tags=None, page_size=1000):
        # REVERSED creation order: the server promises no creation order
        # (ObjectIds from different Girder instances interleave), so any
        # code that relies on it must fail here.
        return iter(reversed(self.list(shape=shape, tags=tags)))

    def count(self, shape=None):
        return len(self.list(shape=shape))

    def get_many(self, annotation_ids):
        wanted = {str(i) for i in annotation_ids}
        return [a for a in self._mine() if a.id in wanted]

    def update_many(self, updates):
        self._server.write(self._id, "update_many")
        for annotation_id, change in updates:
            annotation = self._server.annotations[annotation_id]
            assert annotation.dataset_id == self._id, "cross-dataset write"
            annotation.tags = list(change["tags"])

    def delete_many(self, annotation_ids):
        self._server.write(self._id, "delete_many")
        for annotation_id in annotation_ids:
            del self._server.annotations[annotation_id]


class FakeProperties:
    def __init__(self, server, dataset_id):
        self._server, self._id = server, dataset_id

    def get_or_create(self, name, shape):
        self._server.write(self._id, "get_or_create")
        return SimpleNamespace(id=f"prop_{name}")

    def register(self, property_id):
        self._server.write(self._id, "register")

    def submit_values(self, property_id, values):
        self._server.write(self._id, "submit_values")
        for annotation_id in values:
            owner = self._server.annotations[annotation_id].dataset_id
            assert owner == self._id, "cross-dataset write"
        self._server.values.setdefault(property_id, {}).update(values)

    def delete_values(self, property_id):
        self._server.write(self._id, "delete_values")
        self._server.values.pop(property_id, None)


class FakeSpatial:
    def __init__(self, server, dataset_id):
        self._server, self._id = server, dataset_id
        self.registered = None

    def upload_transcripts(self, path):
        self._server.write(self._id, "upload_transcripts")
        return {"_id": "item_tx"}

    def register_transcripts(self, item_id, pixel_size, transform):
        self._server.write(self._id, "register_transcripts")
        self.registered = (item_id, pixel_size, transform)
        return {"totalPoints": 10, "genes": 2, "levels": 1}

    def upload_and_register(self, path):
        self._server.write(self._id, "upload_and_register")
        return {"nObs": 3, "nVar": 3, "schemaVersion": 1}


class FakeDataset:
    def __init__(self, server, dataset_id):
        self.id = dataset_id
        self.name = f"Fake {dataset_id}"
        self.annotations = FakeAnnotations(server, dataset_id)
        self.properties = FakeProperties(server, dataset_id)
        self.spatial = FakeSpatial(server, dataset_id)


@pytest.fixture
def server():
    return FakeServer()


def _values(server, name):
    return server.values.get(f"prop_{name}", {})


MORPH = "ds_morph"
OTHER = "ds_other"
HE = "ds_he"


class TestBundle:
    def test_manifest(self, bundle):
        assert bundle.pixel_size == PIXEL_SIZE
        assert bundle.number_of_cells == 4

    def test_polygons_are_microns(self, bundle):
        n_vertices, vertices = bundle.polygons("cell")
        assert list(n_vertices) == [4, 3, 2, 5]
        assert vertices[3, :2].tolist() == [30, 30]

    def test_unknown_polygon_set_raises(self, bundle):
        with pytest.raises(XeniumError, match="not in"):
            bundle.polygons("membrane")

    def test_decode_cell_id(self):
        assert decode_cell_id("aaaaadoa-1") == (992, 1)
        assert decode_cell_id("aaaaaaab-2") == (1, 2)

    def test_cell_types_join_on_id_not_row_order(self, bundle):
        # The CSV is written in reverse order.
        assert (
            bundle.cell_types(bundle.directory / "cell_types.csv")
            == CELL_TYPES
        )

    def test_cell_types_missing_row_raises(self, bundle):
        csv = bundle.directory / "partial.csv"
        csv.write_text(f"cell_id,group\n{CELL_IDS[0]},T cell\n")
        with pytest.raises(XeniumError, match="3 cells have no row"):
            bundle.cell_types(csv)
        assert bundle.cell_types(csv, complete=False) == [
            "T cell",
            None,
            None,
            None,
        ]

    def test_cell_types_duplicate_raises(self, bundle):
        csv = bundle.directory / "dup.csv"
        csv.write_text(f"cell_id,group\n{CELL_IDS[0]},A\n{CELL_IDS[0]},B\n")
        with pytest.raises(XeniumError, match="duplicate"):
            bundle.cell_types(csv)

    def test_cell_groups_handles_zero_padding(self, bundle):
        labels = bundle.cell_groups()
        assert list(labels) == ["graphclust"]
        assert labels["graphclust"].tolist() == [1, 2, 1, 0]

    def test_gene_counts(self, bundle):
        counts = bundle.gene_counts(["GENEA"])
        cells, values = counts["GENEA"]
        assert cells.tolist() == [0, 2]
        assert values.tolist() == [3, 1]

    def test_gene_counts_rejects_missing_and_non_genes(self, bundle):
        with pytest.raises(XeniumError, match="not genes of this panel"):
            bundle.gene_counts(["NOPE"])
        with pytest.raises(XeniumError, match=r"\['NegCtrl'\]"):
            bundle.gene_counts(["NegCtrl"])

    def test_gene_lookup_skips_a_same_named_protein(self, bundle):
        assert bundle.gene_rows(["CD3E"]) == {"CD3E": 3}
        cells, values = bundle.gene_counts(["CD3E"])["CD3E"]
        assert (cells.tolist(), values.tolist()) == ([1, 3], [5, 2])

    def test_missing_files_raise_xenium_error(self, tmp_path):
        empty = XeniumBundle(tmp_path)
        for read in (
            lambda: empty.pixel_size,
            lambda: empty.number_of_cells,
            lambda: empty.polygons(),
            lambda: empty.cell_groups(),
            lambda: empty.gene_rows(["A"]),
        ):
            with pytest.raises(XeniumError, match="missing from the bundle"):
                read()

    def test_unknown_or_malformed_cell_id_raises_xenium_error(self, bundle):
        for bad in ("pppppppp-9", "not-an-id-at-all"):
            csv = bundle.directory / "bad.csv"
            csv.write_text(f"cell_id,group\n{bad},T cell\n")
            with pytest.raises(XeniumError, match="not a cell of this bundle"):
                bundle.cell_types(csv, complete=False)

    def test_cell_types_needs_its_columns(self, bundle):
        csv = bundle.directory / "cols.csv"
        csv.write_text("barcode,label\nx,y\n")
        with pytest.raises(XeniumError, match="cell_id and group"):
            bundle.cell_types(csv)

    def test_counts_are_cells_by_features_and_name_proteins(self, bundle):
        csc, symbols, feature_ids, kinds = bundle.counts()
        assert symbols == ["GENEA", "CD3E" + PROTEIN_SUFFIX, "CD3E"]
        assert kinds == ["gene", "protein", "gene"]
        assert feature_ids == ["ID0", "ID2", "ID3"]
        assert csc.toarray().tolist() == [
            [3, 7, 0],
            [0, 0, 5],
            [1, 0, 0],
            [0, 9, 2],
        ]


class TestMorphologyNames:
    XML = (
        "<OME><Image><Pixels>"
        '<Channel ID="Channel:0" Name="DAPI"/>'
        '<Channel ID="Channel:1" Name="ATP1A1/CD45/E-Cadherin"/>'
        '<TiffData FirstC="1" IFD="0">'
        '<UUID FileName="ch0001_atp1a1.ome.tif">u</UUID></TiffData>'
        '<TiffData FirstC="0" IFD="0">'
        '<UUID FileName="ch0000_dapi.ome.tif">u</UUID></TiffData>'
        "</Pixels></Image></OME>"
    )

    def test_names_follow_tiff_data_not_file_order(self):
        files = [Path("ch0000_dapi.ome.tif"), Path("ch0001_atp1a1.ome.tif")]
        names = ome_channel_names(self.XML, files)
        assert names == {files[0]: "DAPI", files[1]: "ATP1A1/CD45/E-Cadherin"}

    def test_falls_back_to_stem(self):
        files = [Path("morphology_focus_0000.ome.tif")]
        assert ome_channel_names("", files) == {
            files[0]: "morphology_focus_0000"
        }

    def test_staged_names_have_no_token_separators(self):
        assert staged_channel_file_name(1, "ATP1A1/CD45/E-Cadherin") == (
            "c01-ATP1A1+CD45+E-Cadherin.ome.tif"
        )
        assert (
            staged_channel_file_name(0, "Alpha SMA_x")
            == "c00-Alpha-SMA-x.ome.tif"
        )


class TestUmap:
    def test_pca_is_saved_before_umap_runs(
        self, bundle, tmp_path, monkeypatch
    ):
        """A UMAP failure (the slow, memory-heavy step) keeps pca.npy."""
        pytest.importorskip("sklearn")
        import sys
        import types

        from nimbusimage.xenium import compute_umap

        def failing_umap(**kwargs):
            raise MemoryError("umap ran out of memory")

        monkeypatch.setitem(
            sys.modules, "umap", types.SimpleNamespace(UMAP=failing_umap)
        )
        out = tmp_path / "nested" / "umap"
        with pytest.raises(MemoryError):
            compute_umap(bundle, out, components=1)
        assert np.load(out / "pca.npy").shape == (4, 1)
        assert not (out / "umap_xy.npy").exists()


# --- ImageFrame ---


class TestImageFrame:
    M = np.array([[0.0, -2.0, 100.0], [2.0, 0.0, 0.0], [0.0, 0.0, 1.0]])

    @pytest.mark.parametrize(
        "kwargs, message",
        [
            (dict(image="mri", pixel_size=1), "image must be one of"),
            (dict(image="morphology", pixel_size=0), "must be > 0"),
            (dict(image="morphology", pixel_size=-0.2), "must be > 0"),
            (dict(image="morphology", pixel_size=float("nan")), "must be > 0"),
            (dict(image="morphology", pixel_size="x"), "not a number"),
            (dict(image="he", pixel_size=1), "needs the H&E alignment"),
            (dict(image="he", pixel_size=1, alignment=np.eye(2)), "3x3"),
            (
                dict(image="he", pixel_size=1, alignment=np.zeros((3, 3))),
                "singular",
            ),
        ],
    )
    def test_validated_on_construction(self, kwargs, message):
        with pytest.raises(XeniumError, match=message):
            ImageFrame(**kwargs)

    def test_bad_alignment_file(self, tmp_path):
        with pytest.raises(XeniumError, match="cannot read alignment"):
            ImageFrame("he", 1, tmp_path / "missing.csv")

    def test_create_defaults(self, bundle, tmp_path):
        frame = ImageFrame.create(bundle=bundle)
        assert (frame.image, frame.pixel_size) == ("morphology", PIXEL_SIZE)
        assert frame.transform is None
        csv = tmp_path / "m.csv"
        np.savetxt(csv, self.M, delimiter=",")
        he = ImageFrame.create(bundle=bundle, alignment=csv, pixel_size=0.25)
        assert (he.image, he.pixel_size) == ("he", 0.25)
        np.testing.assert_allclose(he.transform, np.linalg.inv(self.M))
        # A pixel size given explicitly needs no bundle.
        assert ImageFrame.create(pixel_size=0.3).pixel_size == 0.3

    def test_microns_to_pixels(self):
        xy = np.array([[10.0, 20.0]])
        morph = ImageFrame("morphology", 0.5)
        np.testing.assert_allclose(morph.microns_to_pixels(xy), xy / 0.5)
        he = ImageFrame("he", 0.5, self.M)
        expected = (np.linalg.inv(self.M) @ [20.0, 40.0, 1.0])[:2]
        np.testing.assert_allclose(he.microns_to_pixels(xy)[0], expected)
        with pytest.raises(XeniumError, match="needs a pixel size"):
            ImageFrame("morphology", None).microns_to_pixels(xy)

    def test_region_transform_table(self):
        xy = np.array([[10.0, 20.0]])
        inverse = np.linalg.inv(self.M)

        def affine(matrix, points):
            return (matrix @ np.column_stack([points, [1.0]]).T).T[:, :2]

        morph = ImageFrame("morphology", 0.5, self.M)
        he = ImageFrame("he", 0.5, self.M)
        cases = {
            (he, "he"): xy,
            (morph, "he"): affine(self.M, xy),
            (morph, "morphology"): xy,
            (he, "morphology"): affine(inverse, xy),
            (morph, "microns"): xy / 0.5,
            (he, "microns"): affine(inverse, xy / 0.5),
        }
        for (frame, drawn_in), expected in cases.items():
            np.testing.assert_allclose(
                frame.region_transform(drawn_in)(xy),
                expected,
                err_msg=f"{drawn_in} -> {frame.image}",
            )
        with pytest.raises(XeniumError, match="need the H&E alignment"):
            ImageFrame("morphology", 0.5).region_transform("he")

    def test_dict_round_trip_and_matches(self):
        he = ImageFrame("he", 0.2125, self.M)
        again = ImageFrame.from_dict(json.loads(json.dumps(he.to_dict())))
        assert again.matches(he)
        assert not again.matches(ImageFrame("he", 0.25, self.M))
        assert not again.matches(ImageFrame("morphology", 0.2125, self.M))
        assert not ImageFrame("morphology", 1).matches(
            ImageFrame("morphology", 1, self.M)
        )


# --- CellMap ---


def _upload(server, bundle, dataset_id=MORPH, **kwargs):
    return upload_polygons(server.dataset(dataset_id), bundle, **kwargs)


class TestCellMap:
    def test_save_and_read_need_no_pickle(self, server, bundle, tmp_path):
        cells = _upload(server, bundle)
        path = cells.save(tmp_path / "cells.npz")
        with np.load(path, allow_pickle=False) as raw:
            assert set(raw.files) == {"ids", "meta"}
        again = CellMap.read(path)
        assert again.ids.tolist() == cells.ids.tolist()
        assert again.dataset_id == MORPH
        assert again.frame.matches(cells.frame)

    def test_saved_under_the_exact_name(self, server, bundle, tmp_path):
        path = _upload(server, bundle).save(tmp_path / "ids_morph.npy")
        assert path.name == "ids_morph.npy" and path.exists()
        assert isinstance(CellMap.read(path), CellMap)

    def test_check_is_the_one_guard(self, server, bundle):
        cells = _upload(server, bundle)
        cells.check(bundle, server.dataset(MORPH))
        with pytest.raises(XeniumError, match="belong to dataset ds_morph"):
            cells.check(bundle, server.dataset(OTHER))
        nuclei = _upload(server, bundle, polygon_set="nucleus")
        with pytest.raises(XeniumError, match="needs the cell polygons"):
            nuclei.check(bundle)
        short = CellMap(MORPH, cells.frame, cells.ids[:3])
        with pytest.raises(XeniumError, match="3 ids for 4 cells"):
            short.check(bundle)


# --- polygons ---


class TestPolygons:
    def test_one_slot_per_cell_even_with_limit(self, server, bundle):
        cells = _upload(server, bundle, limit=2)
        assert cells.ids.tolist() == ["ann_0", "ann_1", None, None]
        cells = _upload(server, bundle, dataset_id=OTHER)
        assert cells.ids.tolist() == ["ann_2", "ann_3", None, "ann_4"]
        assert cells.dataset_id == OTHER

    def test_batches(self, server, bundle):
        _upload(server, bundle, batch=2)
        assert server.writes == [(MORPH, "create_many")] * 2

    def test_coordinates_follow_the_frame(self, server, bundle):
        matrix = np.diag([2.0, 2.0, 1.0])
        frame = ImageFrame.create(bundle=bundle, alignment=matrix)
        cells = _upload(server, bundle, frame=frame, limit=1)
        second = server.annotations[cells.ids[0]].coordinates[1]
        # (4, 0) um -> 8 morphology px -> 4 H&E px
        assert (second["x"], second["y"]) == (4.0, 0.0)
        assert cells.frame is frame

    def test_short_create_raises(self, server, bundle):
        ds = server.dataset(MORPH)
        ds.annotations.create_many = lambda batch: batch[:-1]
        with pytest.raises(XeniumError, match="created 2 of 3"):
            upload_polygons(ds, bundle)

    def test_delete_tag_only_after_inputs_are_read(self, server, bundle):
        _upload(server, bundle, tags=["test"])
        server.writes.clear()
        for bad in (
            dict(polygon_set="membrane"),
            dict(limit=0),
            dict(batch=0),
        ):
            with pytest.raises(XeniumError):
                _upload(server, bundle, delete_tag="test", **bad)
        assert server.writes == []
        _upload(server, bundle, delete_tag="test")
        assert server.writes[0] == (MORPH, "delete_many")
        assert len(server.dataset(MORPH).annotations.list()) == 3


# --- fetching and opening cell maps ---


class TestOpenCells:
    def test_fetch_matches_the_upload_in_any_order(self, server, bundle):
        """The fake lists in REVERSE creation order: matching is by
        geometry, not position, and other polygons are ignored."""
        ds = server.dataset(MORPH)
        region = SimpleNamespace(
            shape="polygon",
            tags=["region"],
            coordinates=[{"x": 0, "y": 0}, {"x": 9, "y": 0}, {"x": 9, "y": 9}],
        )
        ds.annotations.create_many([region])  # a polygon that is no cell
        uploaded = _upload(server, bundle)
        fetched = fetch_cells(ds, bundle, uploaded.frame)
        assert fetched.ids.tolist() == uploaded.ids.tolist()
        assert fetched.ids.tolist() == ["ann_1", "ann_2", None, "ann_3"]

    @pytest.mark.parametrize("nudge, matches", [(1e-3, True), (0.05, False)])
    def test_matching_tolerates_float_arithmetic_only(
        self, server, bundle, nudge, matches
    ):
        """Uploads by older code (float32 arithmetic) land ~1e-3 px away at
        H&E scale; exact keys matched 16% of a real 465K-cell dataset."""
        uploaded = _upload(server, bundle)
        for annotation in server.annotations.values():
            annotation.coordinates = [
                {"x": c["x"] + nudge, "y": c["y"] - nudge}
                for c in annotation.coordinates
            ]
        ds = server.dataset(MORPH)
        if matches:
            fetched = fetch_cells(ds, bundle, uploaded.frame)
            assert fetched.ids.tolist() == uploaded.ids.tolist()
        else:
            with pytest.raises(XeniumError, match="none of the 3 polygon"):
                fetch_cells(ds, bundle, uploaded.frame)

    def test_a_limited_upload_can_be_re_derived(self, server, bundle):
        uploaded = _upload(server, bundle, limit=2)
        fetched = fetch_cells(server.dataset(MORPH), bundle, uploaded.frame)
        assert fetched.ids.tolist() == ["ann_0", "ann_1", None, None]

    def test_a_duplicate_upload_is_an_error(self, server, bundle):
        frame = _upload(server, bundle).frame
        _upload(server, bundle)
        with pytest.raises(XeniumError, match="uploaded twice"):
            fetch_cells(server.dataset(MORPH), bundle, frame)

    def test_the_wrong_frame_matches_nothing(self, server, bundle):
        _upload(server, bundle)
        with pytest.raises(XeniumError, match="none of the 3 polygon"):
            fetch_cells(
                server.dataset(MORPH),
                bundle,
                ImageFrame.create(pixel_size=0.25),
            )

    def test_open_cells_re_derives_and_saves(self, server, bundle, tmp_path):
        _upload(server, bundle)
        path = tmp_path / "derived.npz"
        cells = open_cells(server.dataset(MORPH), bundle, path)
        assert cells.ids.tolist() == ["ann_0", "ann_1", None, "ann_2"]
        assert CellMap.read(path).dataset_id == MORPH

    def test_cells_files_load_without_unpickling(self, tmp_path):
        """A .npz with an object array could run code if unpickled."""
        hostile = tmp_path / "hostile.npz"
        meta = {
            "format": 1,
            "datasetId": MORPH,
            "polygonSet": "cell",
            "frame": ImageFrame("morphology", 1).to_dict(),
        }
        np.savez(
            hostile,
            ids=np.array([object()], dtype=object),
            meta=np.array(json.dumps(meta)),
        )
        with pytest.raises(XeniumError, match="not a cells file"):
            CellMap.read(hostile)

    def test_a_pickle_passed_as_cells_never_runs(self, tmp_path):
        """np.load(allow_pickle=True) unpickles ANY non-numpy file; only a
        real .npy may reach it."""
        import pickle

        marker = tmp_path / "ran"

        class Payload:
            def __reduce__(self):
                return (pathlib_touch, (str(marker),))

        hostile = tmp_path / "cells.npz"
        hostile.write_bytes(pickle.dumps(Payload()))
        with pytest.raises(XeniumError, match="not a cells file"):
            CellMap.read(hostile)
        assert not marker.exists(), "a pickle in a cells file was executed"

    @pytest.mark.parametrize("content", ["other", "no meta", "bad meta"])
    def test_foreign_files_are_a_xenium_error(self, tmp_path, content):
        path = tmp_path / "foreign.npz"
        if content == "other":
            path.write_bytes(b"not a numpy file at all")
        elif content == "no meta":
            np.savez(path, ids=np.array(["a"]))
        else:
            np.savez(path, ids=np.array(["a"]), meta=np.array('{"x": 1}'))
        with pytest.raises(XeniumError):
            CellMap.read(path)

    def test_saved_map_round_trip_verified(self, server, bundle, tmp_path):
        path = _upload(server, bundle).save(tmp_path / "cells.npz")
        cells = open_cells(server.dataset(MORPH), bundle, path)
        assert cells.ids.tolist() == ["ann_0", "ann_1", None, "ann_2"]

    def test_another_datasets_map_is_refused_offline(
        self, server, bundle, tmp_path
    ):
        path = _upload(server, bundle).save(tmp_path / "cells.npz")
        other = server.dataset(OTHER)
        other.annotations.get_many = None  # must not be reached
        with pytest.raises(XeniumError, match="belong to dataset ds_morph"):
            open_cells(other, bundle, path)

    def test_bare_id_file_of_another_dataset(self, server, bundle, tmp_path):
        """Pre-CellMap files record no dataset: the spot-check catches the
        morphology file used for the H&E dataset (same cell count)."""
        cells = _upload(server, bundle)
        _upload(server, bundle, dataset_id=OTHER)
        legacy = tmp_path / "ids_morph.npy"
        np.save(legacy, cells.ids)
        with pytest.raises(XeniumError, match="not annotations of dataset"):
            open_cells(server.dataset(OTHER), bundle, legacy)
        assert open_cells(server.dataset(MORPH), bundle, legacy)

    def test_bare_id_file_with_the_wrong_frame(self, server, bundle, tmp_path):
        cells = _upload(server, bundle)
        legacy = tmp_path / "ids.npy"
        np.save(legacy, cells.ids)
        with pytest.raises(XeniumError, match="another frame"):
            open_cells(
                server.dataset(MORPH),
                bundle,
                legacy,
                frame=ImageFrame.create(pixel_size=0.25),
            )

    def test_a_given_frame_must_match_the_saved_one(
        self, server, bundle, tmp_path
    ):
        path = _upload(server, bundle).save(tmp_path / "cells.npz")
        with pytest.raises(XeniumError, match="conflicts"):
            open_cells(
                server.dataset(MORPH),
                bundle,
                path,
                frame=ImageFrame.create(pixel_size=0.25),
            )

    def test_empty_map_is_an_error(self, server, bundle, tmp_path):
        empty = CellMap(MORPH, ImageFrame.create(bundle=bundle), [None] * 4)
        with pytest.raises(XeniumError, match="holds no annotation ids"):
            open_cells(
                server.dataset(MORPH), bundle, empty.save(tmp_path / "e.npz")
            )


# --- per-cell steps ---


@pytest.fixture
def uploaded(server, bundle):
    """The morphology dataset with its cell polygons, and the cell map."""
    return server.dataset(MORPH), _upload(server, bundle)


class TestPerCellSteps:
    def test_gene_panel_dense_with_same_named_protein(
        self, server, bundle, uploaded
    ):
        ds, cells = uploaded
        upload_gene_panel(ds, bundle, cells, ["GENEA", "CD3E"], chunk=3)
        assert _values(server, "Gene Expression") == {
            "ann_0": {"GENEA": 3, "CD3E": 0},
            "ann_1": {"GENEA": 0, "CD3E": 5},
            "ann_2": {"GENEA": 0, "CD3E": 2},
        }

    def test_gene_panel_sparse_replace_and_limit(
        self, server, bundle, uploaded
    ):
        ds, cells = uploaded
        upload_gene_panel(
            ds, bundle, cells, ["GENEA"], dense=False, replace=True, limit=1
        )
        assert _values(server, "Gene Expression") == {"ann_0": {"GENEA": 3}}
        assert (MORPH, "delete_values") in server.writes

    def test_clusters(self, server, bundle, uploaded):
        ds, cells = uploaded
        upload_clusters(ds, bundle, cells)
        assert _values(server, "Clustering") == {
            "ann_0": {"graphclust": 1},
            "ann_1": {"graphclust": 2},
            "ann_2": {"graphclust": 0},
        }

    def test_umap_array_or_file_with_limit(
        self, server, bundle, uploaded, tmp_path
    ):
        ds, cells = uploaded
        embedding = np.arange(8, dtype=np.float32).reshape(4, 2)
        path = tmp_path / "umap_xy.npy"
        np.save(path, embedding)
        for source in (embedding, path):
            upload_umap(ds, bundle, cells, source, limit=2, replace=True)
            assert _values(server, "UMAP") == {
                "ann_0": {"x": 0.0, "y": 1.0},
                "ann_1": {"x": 2.0, "y": 3.0},
            }

    def test_umap_must_cover_exactly_this_bundle(
        self, server, bundle, uploaded
    ):
        ds, cells = uploaded
        for shape in [(3, 2), (4, 3), (5, 2)]:
            with pytest.raises(XeniumError, match=r"expected \(4, 2\)"):
                upload_umap(ds, bundle, cells, np.zeros(shape))

    def test_cell_types_and_read_back(self, server, bundle, uploaded):
        ds, cells = uploaded
        counts = upload_cell_types(
            ds, bundle, cells, bundle.directory / "cell_types.csv"
        )
        tags = {a.id: a.tags for a in ds.annotations.list()}
        assert tags == {
            "ann_0": ["cell", "T cell"],
            "ann_1": ["cell", "B cell"],
            "ann_2": ["cell", "Macrophage"],
        }
        assert counts["T cell"] == 2

    def test_cell_types_read_back_mismatch(self, server, bundle, uploaded):
        ds, cells = uploaded
        ds.annotations.update_many = lambda updates: None  # write lost
        with pytest.raises(XeniumError, match="verify failed"):
            upload_cell_types(
                ds, bundle, cells, bundle.directory / "cell_types.csv"
            )

    def test_cell_types_gaps_only_with_reset(self, server, bundle, uploaded):
        ds, cells = uploaded
        labels = ["T cell", None, "B cell", None]
        with pytest.raises(XeniumError, match="2 cells have no cell-type"):
            upload_cell_types(ds, bundle, cells, labels)
        upload_cell_types(ds, bundle, cells, labels, reset=True)
        assert {tuple(a.tags) for a in ds.annotations.list()} == {("cell",)}

    def test_spatial_table_round_trip(self, bundle, uploaded, tmp_path):
        anndata = pytest.importorskip("anndata")
        _, cells = uploaded
        out = build_spatial_table(
            bundle,
            cells,
            tmp_path / "spatial.zarr.zip",
            cell_types=bundle.directory / "cell_types.csv",
            umap=np.arange(8, dtype=np.float32).reshape(4, 2),
        )
        extracted = tmp_path / "extracted.zarr"
        with zipfile.ZipFile(out) as zf:
            assert "zarr.json" not in zf.namelist()  # zarr v2 for the server
            zf.extractall(extracted)
        adata = anndata.read_zarr(extracted)
        assert adata.obs["annotation_id"].tolist() == [
            "ann_0",
            "ann_1",
            "ann_2",
        ]
        assert adata.obs["cell_index"].tolist() == [0, 1, 3]
        assert adata.obs["cell_type"].tolist() == [
            "T cell",
            "B cell",
            "Macrophage",
        ]
        assert adata.obs["graphclust"].tolist() == [1, 2, 0]
        assert list(adata.var_names) == ["GENEA", "CD3E (protein)", "CD3E"]
        assert np.asarray(adata.X.todense()).tolist() == [
            [3, 7, 0],
            [0, 0, 5],
            [0, 9, 2],
        ]
        assert adata.obsm["X_umap"].tolist() == [[0, 1], [2, 3], [6, 7]]
        assert adata.uns["nimbus"]["datasetId"] == MORPH

    def test_spatial_table_checks_before_reading_the_matrix(
        self, bundle, uploaded, tmp_path, monkeypatch
    ):
        pytest.importorskip("anndata")
        _, cells = uploaded

        def matrix_read(*args, **kwargs):
            raise AssertionError("read the matrix before a cheap check")

        monkeypatch.setattr(bundle, "counts", matrix_read)
        (bundle.directory / "analysis.zarr.zip").unlink()
        with pytest.raises(XeniumError, match="missing from the bundle"):
            build_spatial_table(bundle, cells, tmp_path / "x.zip")


class TestTranscriptsAndRegions:
    def test_transcripts_use_the_frame(self, server, bundle):
        ds = server.dataset(MORPH)
        matrix = np.diag([2.0, 2.0, 1.0])
        frame = ImageFrame.create(pixel_size=0.25, alignment=matrix)
        register_transcripts(ds, bundle, frame)
        item, pixel_size, transform = ds.spatial.registered
        assert (item, pixel_size) == ("item_tx", 0.25)
        np.testing.assert_allclose(transform, np.diag([0.5, 0.5, 1.0]))

    def test_transcripts_take_the_datasets_cell_map(self, server, bundle):
        cells = _upload(server, bundle)
        ds = server.dataset(MORPH)
        register_transcripts(ds, bundle, cells, item_id="item_1")
        assert ds.spatial.registered == ("item_1", PIXEL_SIZE, None)
        assert (MORPH, "upload_transcripts") not in server.writes
        with pytest.raises(XeniumError, match="belong to dataset ds_morph"):
            register_transcripts(server.dataset(OTHER), bundle, cells)

    def test_transcripts_never_default_the_frame(self, server, bundle):
        with pytest.raises(XeniumError, match="explicit ImageFrame"):
            register_transcripts(server.dataset(MORPH), bundle, None)

    def test_regions_may_only_add_an_alignment(self, server, bundle):
        cells = _upload(server, bundle)
        geojson = {
            "features": [
                {
                    "properties": {"name": "R"},
                    "geometry": {
                        "type": "Polygon",
                        "coordinates": [[[0, 0], [9, 0], [9, 9]]],
                    },
                }
            ]
        }
        ds = server.dataset(MORPH)
        upload_regions(
            ds,
            geojson,
            cells,
            drawn_in="he",
            alignment=np.diag([2.0, 2.0, 1.0]),
        )
        region = ds.annotations.list(tags=["region"])[0]
        assert region.coordinates[1] == {"x": 18.0, "y": 0.0}
        he = ImageFrame.create(bundle=bundle, alignment=np.diag([2, 2, 1.0]))
        with pytest.raises(XeniumError, match="differs"):
            he.with_alignment(np.diag([3.0, 3.0, 1.0]))

    def test_spatial_table_upload_checks_the_dataset(
        self, server, bundle, tmp_path
    ):
        cells = _upload(server, bundle)
        with pytest.raises(XeniumError, match="belong to dataset ds_morph"):
            upload_spatial_table(server.dataset(OTHER), cells, tmp_path / "t")
        assert server.writes[-1][1] == "create_many"

    def test_regions_class_first_and_ring_closed(self):
        geojson = {
            "features": [
                {
                    "properties": {"classification": {"name": "Tumor"}},
                    "geometry": {
                        "type": "Polygon",
                        "coordinates": [[[0, 0], [4, 0], [4, 4], [0, 0]]],
                    },
                },
                {
                    "properties": {"name": "Immune"},
                    "geometry": {
                        "type": "MultiPolygon",
                        "coordinates": [
                            [[[0, 0], [1, 0], [1, 1]]],
                            [[[5, 5], [6, 5]]],
                        ],
                    },
                },
            ]
        }
        annotations = region_annotations(
            geojson,
            MORPH,
            ImageFrame("morphology", None),
            drawn_in="morphology",
        )
        assert [a.tags for a in annotations] == [
            ["Tumor", "region"],
            ["Immune", "region"],
        ]
        assert len(annotations[0].coordinates) == 3


# --- CONTRACT: every per-cell step refuses a wrong cell map, unwritten ---


PER_CELL_STEPS = {
    "gene panel": lambda ds, b, c: upload_gene_panel(ds, b, c, ["GENEA"]),
    "clusters": lambda ds, b, c: upload_clusters(ds, b, c),
    "umap": lambda ds, b, c: upload_umap(ds, b, c, np.zeros((4, 2))),
    "cell types": lambda ds, b, c: upload_cell_types(
        ds, b, c, b.directory / "cell_types.csv"
    ),
}


def _wrong_cell_maps(server, bundle):
    right = _upload(server, bundle)
    return {
        "another dataset's": right,  # used against OTHER below
        "nucleus": _upload(server, bundle, polygon_set="nucleus"),
        "another bundle's": CellMap(MORPH, right.frame, right.ids[:3]),
        "bare ids": right.ids,
    }


@pytest.mark.parametrize("step", sorted(PER_CELL_STEPS))
@pytest.mark.parametrize(
    "wrong", ["another dataset's", "nucleus", "another bundle's", "bare ids"]
)
def test_per_cell_steps_refuse_wrong_cell_maps(server, bundle, step, wrong):
    cells = _wrong_cell_maps(server, bundle)[wrong]
    target = OTHER if wrong == "another dataset's" else MORPH
    server.writes.clear()
    with pytest.raises(XeniumError):
        PER_CELL_STEPS[step](server.dataset(target), bundle, cells)
    assert server.writes == [], f"{step} wrote before refusing {wrong} cells"


@pytest.mark.parametrize("step", sorted(PER_CELL_STEPS))
def test_per_cell_steps_accept_the_right_cell_map(server, bundle, step):
    """The contract's other half: the same calls succeed with good input."""
    cells = _upload(server, bundle)
    PER_CELL_STEPS[step](server.dataset(MORPH), bundle, cells)


# --- CONTRACT: every CLI subcommand fails on bad input with zero writes ---


@pytest.fixture
def cli(server, bundle, tmp_path, monkeypatch):
    """Runs the CLI against the fake server; ``cells.npz`` holds the
    morphology dataset's cell map, and OTHER has cell polygons too."""
    client = SimpleNamespace(dataset=server.dataset)
    monkeypatch.setattr("nimbusimage.xenium.cli._connect", lambda: client)
    _upload(server, bundle).save(tmp_path / "cells.npz")
    other = _upload(server, bundle, dataset_id=OTHER)
    other.save(tmp_path / "other.npz")
    np.save(tmp_path / "other_ids.npy", other.ids)  # a pre-CellMap file
    np.savetxt(tmp_path / "diag.csv", np.diag([2.0, 2.0, 1.0]), delimiter=",")
    he_frame = ImageFrame.create(
        bundle=bundle, alignment=tmp_path / "diag.csv"
    )
    he = upload_polygons(server.dataset(HE), bundle, he_frame)
    he.save(tmp_path / "cells_he.npz")
    np.save(
        tmp_path / "morph_ids.npy", CellMap.read(tmp_path / "cells.npz").ids
    )
    _upload(server, bundle, polygon_set="nucleus").save(
        tmp_path / "nuclei.npz"
    )
    np.save(tmp_path / "umap.npy", np.zeros((4, 2)))
    np.save(tmp_path / "umap_bad.npy", np.zeros((5, 2)))
    np.savetxt(tmp_path / "singular.csv", np.zeros((3, 3)), delimiter=",")
    (tmp_path / "bad_types.csv").write_text("cell_id,group\npppppppp-9,x\n")
    (tmp_path / "regions.json").write_text(
        json.dumps(
            {
                "features": [
                    {
                        "properties": {"name": "R"},
                        "geometry": {
                            "type": "Polygon",
                            "coordinates": [[[0, 0], [9, 0], [9, 9]]],
                        },
                    },
                ]
            }
        )
    )
    (tmp_path / "bad.json").write_text("{not json")
    server.writes.clear()

    def run(argv):
        argv = [a.format(tmp=tmp_path, bundle=bundle.directory) for a in argv]
        try:
            return cli_main(argv)
        except SystemExit as exc:  # argparse rejects bad flag values
            return exc.code

    return run


BASE = "--bundle-dir {bundle} --dataset ds_morph".split()
CLI_COMMANDS = {
    "polygons": ["polygons", *BASE, "--cells-out", "{tmp}/new.npz"],
    "properties": [
        "properties",
        *BASE,
        "--cells",
        "{tmp}/cells.npz",
        "--what",
        "genes,clusters,umap",
        "--genes",
        "GENEA",
        "--umap",
        "{tmp}/umap.npy",
    ],
    "cell-types": [
        "cell-types",
        *BASE,
        "--cells",
        "{tmp}/cells.npz",
        "--cell-types",
        "{bundle}/cell_types.csv",
    ],
    "transcripts": ["transcripts", *BASE, "--cells", "{tmp}/cells.npz"],
    "regions": [
        "regions",
        "--dataset",
        "ds_morph",
        "--geojson",
        "{tmp}/regions.json",
        "--drawn-in",
        "morphology",
        "--cells",
        "{tmp}/cells.npz",
    ],
}
CLI_COMMANDS["transcripts (H&E)"] = [
    "transcripts",
    "--bundle-dir",
    "{bundle}",
    "--dataset",
    HE,
    "--cells",
    "{tmp}/cells_he.npz",
]
CLI_COMMANDS["regions (H&E)"] = [
    "regions",
    "--dataset",
    HE,
    "--geojson",
    "{tmp}/regions.json",
    "--drawn-in",
    "he",
    "--cells",
    "{tmp}/cells_he.npz",
]
if __import__("importlib").util.find_spec("anndata"):
    CLI_COMMANDS["spatial-table"] = [
        "spatial-table",
        *BASE,
        "--cells",
        "{tmp}/cells.npz",
        "--out",
        "{tmp}/spatial.zarr.zip",
    ]

# (flag edits, commands they apply to). "set" replaces a flag's value.
BAD_INPUTS = {
    "missing bundle": (
        {"--bundle-dir": "{tmp}/nope"},
        [
            "polygons",
            "properties",
            "cell-types",
            "transcripts",
            "spatial-table",
        ],
    ),
    "unreadable alignment": ({"--alignment": "{tmp}/nope.csv"}, "all"),
    "singular alignment": ({"--alignment": "{tmp}/singular.csv"}, "all"),
    "zero pixel size": ({"--pixel-size": "0"}, "all"),
    "negative pixel size": ({"--pixel-size": "-1"}, "all"),
    "conflicting pixel size": (
        {"--pixel-size": "0.3"},
        [
            "properties",
            "cell-types",
            "transcripts",
            "regions",
            "spatial-table",
        ],
    ),
    "another dataset's cells": (
        {"--cells": "{tmp}/other.npz"},
        [
            "properties",
            "cell-types",
            "transcripts",
            "regions",
            "spatial-table",
        ],
    ),
    "another dataset's bare ids": (
        {"--cells": "{tmp}/other_ids.npy"},
        ["properties", "cell-types", "spatial-table"],
    ),
    "nucleus cells": (
        {"--cells": "{tmp}/nuclei.npz"},
        ["properties", "cell-types", "spatial-table"],
    ),
    "zero limit": ({"--limit": "0"}, ["polygons", "properties", "cell-types"]),
    "zero chunk": ({"--chunk": "0"}, ["properties", "cell-types"]),
    "unknown gene": ({"--genes": "NOPE"}, ["properties"]),
    "empty what": ({"--what": ","}, ["properties"]),
    "wrong-size umap": (
        {"--umap": "{tmp}/umap_bad.npy"},
        ["properties", "spatial-table"],
    ),
    "unknown cell id": (
        {"--cell-types": "{tmp}/bad_types.csv"},
        ["cell-types", "spatial-table"],
    ),
    "bad geojson": ({"--geojson": "{tmp}/bad.json"}, ["regions"]),
    "microns without pixel size": (
        {"--drawn-in": "microns", "--cells": None, "--image": "morphology"},
        ["regions"],
    ),
    # Transcripts and regions have nothing to verify a frame against, so
    # they must never fall back to a default one.
    "no frame stated": (
        {"--cells": None},
        ["transcripts", "regions", "transcripts (H&E)", "regions (H&E)"],
    ),
    "mistyped cells path": (
        {"--cells": "{tmp}/cells_typo.npz"},
        ["transcripts", "regions", "transcripts (H&E)", "regions (H&E)"],
    ),
    "bare-id file as the frame": (
        {"--cells": "{tmp}/morph_ids.npy"},
        ["transcripts", "regions"],
    ),
    "alignment on a saved morphology map": (
        {"--alignment": "{tmp}/diag.csv"},
        ["properties", "cell-types", "transcripts", "spatial-table"],
    ),
    "a different alignment than the saved one": (
        {"--alignment": "{tmp}/singular.csv"},
        ["transcripts (H&E)", "regions (H&E)"],
    ),
    "conflicting image": (
        {"--image": "he"},
        ["transcripts", "regions"],
    ),
    "unwritable cells-out": (
        {"--cells-out": "{tmp}/no_such_dir/cells.npz"},
        ["polygons"],
    ),
}


def _edit(argv, edits):
    """Set each flag's value; None removes the flag."""
    argv = list(argv)
    for flag, value in edits.items():
        if flag in argv:
            at = argv.index(flag)
            if value is None:
                del argv[at]  # the flag
                del argv[at]  # its value
            else:
                argv[at + 1] = value
        elif value is not None:
            argv += [flag, value]
    return argv


CLI_CASES = [
    (command, bad)
    for bad, (_, applies) in BAD_INPUTS.items()
    for command in CLI_COMMANDS
    if applies == "all" or command in applies
]


@pytest.mark.parametrize("command", sorted(CLI_COMMANDS))
def test_cli_baseline_succeeds(cli, server, command):
    assert cli(CLI_COMMANDS[command]) == 0
    assert server.writes, f"{command} baseline wrote nothing"


@pytest.mark.parametrize("command, bad", CLI_CASES)
def test_cli_bad_input_fails_with_no_writes(cli, server, capsys, command, bad):
    code = cli(_edit(CLI_COMMANDS[command], BAD_INPUTS[bad][0]))
    assert code not in (0, None), f"{command} accepted {bad}"
    assert server.writes == [], f"{command} wrote before rejecting {bad}"
    if code == 1:  # our own errors print cleanly, never a traceback
        assert "error:" in capsys.readouterr().err


# --- CLI details ---


class TestCli:
    def test_polygons_saves_the_cell_map(self, cli, tmp_path):
        assert cli(CLI_COMMANDS["polygons"]) == 0
        saved = CellMap.read(tmp_path / "new.npz")
        assert saved.dataset_id == MORPH
        assert saved.ids.tolist()[2] is None  # the degenerate cell

    def test_later_steps_reuse_the_saved_frame(self, cli, server, tmp_path):
        """--pixel-size given once, to polygons, reaches transcripts."""
        argv = _edit(CLI_COMMANDS["polygons"], {"--pixel-size": "0.25"})
        argv = _edit(argv, {"--dataset": "ds_new"})
        assert cli(argv) == 0
        transcripts = _edit(
            CLI_COMMANDS["transcripts"],
            {"--dataset": "ds_new", "--cells": "{tmp}/new.npz"},
        )
        assert cli(transcripts) == 0
        assert server.dataset("ds_new").spatial.registered[1] == 0.25

    def test_regions_may_add_an_alignment_to_a_saved_frame(
        self, cli, server, tmp_path
    ):
        np.savetxt(tmp_path / "m.csv", np.diag([2.0, 2.0, 1.0]), delimiter=",")
        argv = _edit(
            CLI_COMMANDS["regions"],
            {"--drawn-in": "he", "--alignment": "{tmp}/m.csv"},
        )
        assert cli(argv) == 0
        region = server.dataset(MORPH).annotations.list(tags=["region"])[0]
        assert region.coordinates[1] == {"x": 18.0, "y": 0.0}

    def test_regions_microns_with_a_pixel_size_needs_no_bundle(
        self, cli, server
    ):
        argv = _edit(
            CLI_COMMANDS["regions"],
            {
                "--drawn-in": "microns",
                "--cells": None,
                "--image": "morphology",
                "--pixel-size": "0.5",
            },
        )
        assert cli(argv) == 0
        region = server.dataset(MORPH).annotations.list(tags=["region"])[0]
        assert region.coordinates[1] == {"x": 18.0, "y": 0.0}

    def test_cell_types_reset_accepts_gaps(self, cli, server, tmp_path):
        partial = tmp_path / "partial.csv"
        partial.write_text(f"cell_id,group\n{CELL_IDS[0]},T cell\n")
        argv = _edit(
            CLI_COMMANDS["cell-types"], {"--cell-types": str(partial)}
        )
        assert cli(argv) == 1
        assert server.writes == []
        assert cli(argv + ["--reset"]) == 0

    def test_main_module_import_does_not_run_the_cli(self):
        import importlib

        importlib.import_module("nimbusimage.xenium.__main__")

    def test_missing_credentials(self, monkeypatch):
        for name in ("NI_API_KEY", "NI_TOKEN", "NI_USERNAME", "NI_PASSWORD"):
            monkeypatch.delenv(name, raising=False)
        from nimbusimage.xenium.cli import _connect

        with pytest.raises(XeniumError, match="NI_API_URL"):
            _connect()

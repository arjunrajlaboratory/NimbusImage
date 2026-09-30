"""Tests for nimbusimage.xenium against a synthetic four-cell bundle."""

import json
import zipfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import numpy as np
import pytest

zarr = pytest.importorskip("zarr")

from nimbusimage.xenium import (  # noqa: E402
    PROTEIN_SUFFIX,
    XeniumBundle,
    XeniumError,
    build_spatial_table,
    decode_cell_id,
    fetch_annotation_ids,
    load_annotation_ids,
    region_annotations,
    region_transform,
    register_transcripts,
    upload_cell_types,
    upload_clusters,
    upload_gene_panel,
    upload_polygons,
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
        for index, polygons in enumerate([CELL_VERTICES, CELL_VERTICES]):
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
    return XeniumBundle(tmp_path)


def _expected_first_vertex(cell: int) -> tuple[float, float]:
    x, y = CELL_VERTICES[cell][0]
    return x / PIXEL_SIZE, y / PIXEL_SIZE


class FakeDataset:
    """Records writes; ``annotations.create_many`` assigns ids ann_<n>."""

    def __init__(self, dataset_id="ds_1"):
        self.id = dataset_id
        self.name = "Fake"
        self.created = []
        self.batch_sizes = []
        self.annotations = MagicMock()
        self.annotations.create_many.side_effect = self._create_many
        self.properties = MagicMock()
        self.properties.get_or_create.side_effect = (
            lambda name, shape: SimpleNamespace(id=f"prop_{name}")
        )
        self.spatial = MagicMock()

    def _create_many(self, annotations):
        self.batch_sizes.append(len(annotations))
        start = len(self.created)
        made = [
            SimpleNamespace(
                id=f"ann_{start + i}", coordinates=a.coordinates, tags=a.tags
            )
            for i, a in enumerate(annotations)
        ]
        self.created.extend(made)
        return made

    def submitted(self, property_id):
        merged = {}
        for call in self.properties.submit_values.call_args_list:
            if call.args[0] == property_id:
                merged.update(call.args[1])
        return merged


ALL_IDS = np.array(["ann_0", "ann_1", "ann_2", "ann_3"], dtype=object)
IDS_WITH_GAP = np.array(["ann_0", "ann_1", None, "ann_3"], dtype=object)


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


class TestAlignment:
    def test_accepts_path_or_matrix(self, tmp_path):
        from nimbusimage.xenium import inverse_alignment, load_alignment

        matrix = np.diag([2.0, 4.0, 1.0])
        csv = tmp_path / "m.csv"
        np.savetxt(csv, matrix, delimiter=",")
        np.testing.assert_allclose(load_alignment(csv), matrix)
        expected = np.diag([0.5, 0.25, 1.0])
        np.testing.assert_allclose(inverse_alignment(csv), expected)
        np.testing.assert_allclose(inverse_alignment(matrix), expected)
        assert inverse_alignment(None) is None

    def test_bad_alignments(self, tmp_path):
        from nimbusimage.xenium import inverse_alignment

        with pytest.raises(XeniumError, match="3x3"):
            inverse_alignment(np.eye(2))
        with pytest.raises(XeniumError, match="singular"):
            inverse_alignment(np.zeros((3, 3)))
        with pytest.raises(XeniumError, match="cannot read"):
            inverse_alignment(tmp_path / "missing.csv")


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


class TestRegionTransform:
    M = np.array([[0.0, -2.0, 100.0], [2.0, 0.0, 0.0], [0.0, 0.0, 1.0]])
    XY = np.array([[10.0, 20.0]])

    def _apply(self, matrix, xy):
        return (matrix @ np.column_stack([xy, np.ones(len(xy))]).T).T[:, :2]

    def test_table(self):
        inverse = np.linalg.inv(self.M)
        cases = {
            ("he", "he"): self.XY,
            ("he", "morphology"): self._apply(self.M, self.XY),
            ("morphology", "morphology"): self.XY,
            ("morphology", "he"): self._apply(inverse, self.XY),
            ("microns", "morphology"): self.XY / 0.5,
            ("microns", "he"): self._apply(inverse, self.XY / 0.5),
        }
        for (frame, target), expected in cases.items():
            actual = region_transform(frame, target, self.M, 0.5)(self.XY)
            np.testing.assert_allclose(
                actual, expected, err_msg=f"{frame}->{target}"
            )

    def test_needs_alignment(self):
        with pytest.raises(XeniumError, match="alignment is required"):
            region_transform("he", "morphology")
        with pytest.raises(XeniumError, match="pixel_size"):
            region_transform("microns", "morphology")

    def test_singular_alignment_is_a_xenium_error(self):
        with pytest.raises(XeniumError, match="singular"):
            region_transform("morphology", "he", np.zeros((3, 3)))

    def test_region_annotations_class_first_and_ring_closed(self):
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
            geojson, "ds_1", frame="he", target="he"
        )
        assert [a.tags for a in annotations] == [
            ["Tumor", "region"],
            ["Immune", "region"],
        ]
        assert len(annotations[0].coordinates) == 3  # closing vertex dropped


class TestPolygons:
    def test_upload_in_cell_index_order_skipping_degenerates(self, bundle):
        ds = FakeDataset()
        ids = upload_polygons(ds, bundle, batch=2)
        assert ids.tolist() == ["ann_0", "ann_1", None, "ann_2"]
        # batches of 2: [0, 1], [3]
        assert ds.batch_sizes == [2, 1]
        first = ds.created[2].coordinates[0]
        assert (first["x"], first["y"]) == _expected_first_vertex(3)

    def test_alignment_applies_the_inverse(self, bundle, tmp_path):
        matrix = np.array([[2.0, 0, 0], [0, 2.0, 0], [0, 0, 1]])
        csv = tmp_path / "align.csv"
        np.savetxt(csv, matrix, delimiter=",")
        ds = FakeDataset()
        upload_polygons(ds, bundle, alignment=csv, limit=1)
        first = ds.created[0].coordinates[1]  # (4, 0) um -> 8 px -> 4 H&E px
        assert (first["x"], first["y"]) == (4.0, 0.0)

    def test_delete_tag_runs_only_after_inputs_are_read(
        self, bundle, tmp_path
    ):
        ds = FakeDataset()
        bad = tmp_path / "bad.csv"
        bad.write_text("1,2\n3,4\n")
        with pytest.raises(XeniumError, match="3x3"):
            upload_polygons(ds, bundle, alignment=bad, delete_tag="test")
        with pytest.raises(XeniumError, match="not in"):
            upload_polygons(
                ds, bundle, polygon_set="membrane", delete_tag="test"
            )
        ds.annotations.list.assert_not_called()
        ds.annotations.delete_many.assert_not_called()

    def test_delete_tag_then_upload(self, bundle):
        ds = FakeDataset()
        ds.annotations.list.return_value = [SimpleNamespace(id="old_1")]
        upload_polygons(ds, bundle, delete_tag="test")
        ds.annotations.list.assert_called_once_with(tags=["test"])
        ds.annotations.delete_many.assert_called_once_with(["old_1"])
        assert len(ds.created) == 3

    def test_short_create_raises(self, bundle):
        ds = FakeDataset()
        ds.annotations.create_many.side_effect = lambda batch: batch[:-1]
        with pytest.raises(XeniumError, match="created 2 of 3"):
            upload_polygons(ds, bundle)


def _listing_dataset(first_vertices):
    ds = FakeDataset()
    listed = [
        SimpleNamespace(id=f"ann_{i}", coordinates=[{"x": x, "y": y}])
        for i, (x, y) in enumerate(first_vertices)
    ]

    def page(shape, limit, offset):
        return listed[offset:offset + limit]

    ds.annotations.list.side_effect = page
    # get_many is dataset-scoped: only this dataset's ids come back.
    by_id = {annotation.id: annotation for annotation in listed}
    ds.annotations.get_many.side_effect = lambda ann_ids: [
        by_id[i] for i in ann_ids if i in by_id
    ]
    return ds


class TestAnnotationIds:
    def test_fetch_verifies_first_vertices(self, bundle):
        ds = _listing_dataset([_expected_first_vertex(c) for c in range(4)])
        ids = fetch_annotation_ids(ds, bundle, page=3)
        assert ids.tolist() == ALL_IDS.tolist()

    def test_fetch_aborts_on_order_mismatch(self, bundle):
        firsts = [_expected_first_vertex(c) for c in (1, 0, 2, 3)]
        with pytest.raises(XeniumError, match="not in cell_index order"):
            fetch_annotation_ids(_listing_dataset(firsts), bundle)

    def test_fetch_aborts_when_short(self, bundle):
        ds = _listing_dataset([_expected_first_vertex(0)])
        with pytest.raises(XeniumError, match="only 1 of 4"):
            fetch_annotation_ids(ds, bundle)

    def test_cache_round_trip(self, bundle, tmp_path):
        ds = _listing_dataset([_expected_first_vertex(c) for c in range(4)])
        cache = tmp_path / "ids.npy"
        load_annotation_ids(ds, bundle, cache)
        assert cache.exists()
        ds.annotations.list.reset_mock()
        assert (
            load_annotation_ids(ds, bundle, cache).tolist() == ALL_IDS.tolist()
        )
        ds.annotations.list.assert_not_called()

    def test_cached_ids_of_another_dataset_are_rejected(
        self, bundle, tmp_path
    ):
        """Morphology and H&E have the same cell count: length alone would
        accept the other dataset's ids file and write to the wrong one."""
        cache = tmp_path / "ids_other.npy"
        other = [f"other_{c}" for c in range(4)]
        np.save(cache, np.array(other, dtype=object))
        ds = _listing_dataset([_expected_first_vertex(c) for c in range(4)])
        with pytest.raises(XeniumError, match="not annotations of dataset"):
            load_annotation_ids(ds, bundle, cache)

    def test_cached_ids_with_wrong_vertices_are_rejected(
        self, bundle, tmp_path
    ):
        """Right dataset, wrong alignment/pixel size (or a scrambled file)."""
        cache = tmp_path / "ids.npy"
        np.save(cache, ALL_IDS[[1, 0, 2, 3]])
        ds = _listing_dataset([_expected_first_vertex(c) for c in range(4)])
        with pytest.raises(XeniumError, match="do not match"):
            load_annotation_ids(ds, bundle, cache)

    def test_fetch_honours_a_pixel_size_override(self, bundle):
        firsts = [
            tuple(v * PIXEL_SIZE / 0.25 for v in _expected_first_vertex(c))
            for c in range(4)
        ]
        ds = _listing_dataset(firsts)
        with pytest.raises(XeniumError, match="pixel size"):
            fetch_annotation_ids(ds, bundle)
        ids = fetch_annotation_ids(ds, bundle, pixel_size=0.25)
        assert ids.tolist() == ALL_IDS.tolist()


class TestProperties:
    def test_gene_panel_dense_skips_missing_annotations(self, bundle):
        ds = FakeDataset()
        upload_gene_panel(ds, bundle, IDS_WITH_GAP, ["GENEA", "CD3E"], chunk=3)
        assert ds.submitted("prop_Gene Expression") == {
            "ann_0": {"GENEA": 3, "CD3E": 0},
            "ann_1": {"GENEA": 0, "CD3E": 5},
            "ann_3": {"GENEA": 0, "CD3E": 2},
        }
        ds.properties.register.assert_called_with("prop_Gene Expression")
        ds.properties.delete_values.assert_not_called()

    def test_gene_panel_sparse_and_replace(self, bundle):
        ds = FakeDataset()
        upload_gene_panel(
            ds, bundle, ALL_IDS, ["GENEA"], dense=False, replace=True
        )
        assert ds.submitted("prop_Gene Expression") == {
            "ann_0": {"GENEA": 3},
            "ann_2": {"GENEA": 1},
        }
        ds.properties.delete_values.assert_called_once_with(
            "prop_Gene Expression"
        )

    def test_clusters(self, bundle):
        ds = FakeDataset()
        upload_clusters(ds, bundle, ALL_IDS, limit=2)
        assert ds.submitted("prop_Clustering") == {
            "ann_0": {"graphclust": 1},
            "ann_1": {"graphclust": 2},
        }

    def test_umap_accepts_limit_truncated_ids(self, bundle):
        ds = FakeDataset()
        embedding = np.arange(8, dtype=float).reshape(4, 2)
        upload_umap(ds, ALL_IDS[:2], embedding)  # e.g. polygons --limit 2
        assert ds.submitted("prop_UMAP") == {
            "ann_0": {"x": 0.0, "y": 1.0}, "ann_1": {"x": 2.0, "y": 3.0},
        }

    def test_umap_shape_checked(self, bundle):
        ds = FakeDataset()
        with pytest.raises(XeniumError, match="3 rows for 4 ids"):
            upload_umap(ds, ALL_IDS, np.zeros((3, 2)))
        with pytest.raises(XeniumError, match=r"expected \(N, 2\)"):
            upload_umap(ds, ALL_IDS, np.zeros((4, 3)))
        upload_umap(ds, ALL_IDS, np.arange(8, dtype=float).reshape(4, 2))
        assert ds.submitted("prop_UMAP")["ann_3"] == {"x": 6.0, "y": 7.0}


def _tagged(tags):
    return lambda ann_ids: [SimpleNamespace(id=i, tags=tags) for i in ann_ids]


class TestCellTypes:
    def test_tags_and_read_back(self, bundle):
        ds = FakeDataset()
        written = {}
        ds.annotations.update_many.side_effect = (
            lambda updates: written.update(updates)
        )
        ds.annotations.get_many.side_effect = lambda ann_ids: [
            SimpleNamespace(id=i, tags=written[i]["tags"]) for i in ann_ids
        ]
        counts = upload_cell_types(
            ds, bundle, IDS_WITH_GAP, bundle.directory / "cell_types.csv"
        )
        # One batched read-back, not a GET per sampled annotation.
        ds.annotations.get_many.assert_called_once()
        ds.annotations.get.assert_not_called()
        assert written == {
            "ann_0": {"tags": ["cell", "T cell"]},
            "ann_1": {"tags": ["cell", "B cell"]},
            "ann_3": {"tags": ["cell", "Macrophage"]},
        }
        assert counts["T cell"] == 2

    def test_read_back_mismatch_raises(self, bundle):
        ds = FakeDataset()
        ds.annotations.get_many.side_effect = _tagged(["cell"])
        with pytest.raises(XeniumError, match="verify failed"):
            upload_cell_types(
                ds, bundle, ALL_IDS, bundle.directory / "cell_types.csv"
            )

    def test_read_back_missing_annotation_raises(self, bundle):
        ds = FakeDataset()
        ds.annotations.get_many.return_value = []
        with pytest.raises(XeniumError, match="verify failed"):
            upload_cell_types(
                ds, bundle, ALL_IDS, bundle.directory / "cell_types.csv"
            )

    def test_accepts_labels_already_read(self, bundle):
        ds = FakeDataset()
        ds.annotations.get_many.side_effect = _tagged(["cell", "X"])
        upload_cell_types(ds, bundle, ALL_IDS, ["X"] * 4)
        with pytest.raises(XeniumError, match="3 cell-type labels for 4"):
            upload_cell_types(ds, bundle, ALL_IDS, ["X"] * 3)

    def test_labels_with_gaps_are_rejected_unless_resetting(self, bundle):
        ds = FakeDataset()
        ds.annotations.get_many.side_effect = _tagged(["cell"])
        labels = ["T cell", None, "B cell", None]
        with pytest.raises(XeniumError, match="2 cells have no cell-type"):
            upload_cell_types(ds, bundle, ALL_IDS, labels)
        ds.annotations.update_many.assert_not_called()
        upload_cell_types(ds, bundle, ALL_IDS, labels, reset=True)

    def test_reset_writes_base_tags(self, bundle):
        ds = FakeDataset()
        ds.annotations.get_many.side_effect = _tagged(["cell"])
        upload_cell_types(
            ds,
            bundle,
            ALL_IDS,
            bundle.directory / "cell_types.csv",
            reset=True,
        )
        updates = ds.annotations.update_many.call_args.args[0]
        assert all(change == {"tags": ["cell"]} for _, change in updates)


class TestSpatialTable:
    def test_build_round_trip(self, bundle, tmp_path):
        anndata = pytest.importorskip("anndata")
        out = build_spatial_table(
            bundle,
            IDS_WITH_GAP,
            tmp_path / "spatial.zarr.zip",
            dataset_id="ds_1",
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
            "ann_3",
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
        assert adata.uns["nimbus"]["datasetId"] == "ds_1"

    def test_missing_analysis_fails_before_the_matrix_is_read(
        self, bundle, tmp_path, monkeypatch
    ):
        pytest.importorskip("anndata")
        (bundle.directory / "analysis.zarr.zip").unlink()

        def counts_must_not_run(*args, **kwargs):
            raise AssertionError("read the matrix before a cheap check")

        monkeypatch.setattr(bundle, "counts", counts_must_not_run)
        with pytest.raises(XeniumError, match="missing from the bundle"):
            build_spatial_table(
                bundle, ALL_IDS, tmp_path / "x.zip", dataset_id="d"
            )

    def test_ids_must_cover_every_cell(self, bundle, tmp_path):
        with pytest.raises(XeniumError, match="3 ids for 4 cells"):
            build_spatial_table(
                bundle, ALL_IDS[:3], tmp_path / "x.zip", dataset_id="d"
            )


class TestTranscripts:
    def test_registers_inverse_alignment(self, bundle):
        ds = FakeDataset()
        matrix = np.diag([2.0, 2.0, 1.0])
        register_transcripts(ds, bundle, alignment=matrix, item_id="item_1")
        ds.spatial.upload_transcripts.assert_not_called()
        item_id, pixel_size, transform = (
            ds.spatial.register_transcripts.call_args.args
        )
        assert (item_id, pixel_size) == ("item_1", PIXEL_SIZE)
        np.testing.assert_allclose(transform, np.diag([0.5, 0.5, 1.0]))

    def test_bad_inputs_fail_before_the_upload(self, bundle, tmp_path):
        ds = FakeDataset()
        (bundle.directory / "transcripts.zarr.zip").write_bytes(b"x")
        with pytest.raises(XeniumError, match="cannot read alignment"):
            register_transcripts(ds, bundle, alignment=tmp_path / "nope.csv")
        (bundle.directory / "experiment.xenium").unlink()
        fresh = XeniumBundle(bundle.directory)  # pixel_size is cached above
        with pytest.raises(XeniumError, match="missing from the bundle"):
            register_transcripts(ds, fresh)
        ds.spatial.upload_transcripts.assert_not_called()

    def test_uploads_when_no_item(self, bundle):
        ds = FakeDataset()
        (bundle.directory / "transcripts.zarr.zip").write_bytes(b"x")
        ds.spatial.upload_transcripts.return_value = {"_id": "item_2"}
        register_transcripts(ds, bundle)
        assert ds.spatial.register_transcripts.call_args.args == (
            "item_2",
            PIXEL_SIZE,
            None,
        )


class TestCli:
    def test_errors_exit_nonzero_without_traceback(
        self, bundle, monkeypatch, capsys
    ):
        monkeypatch.setattr(
            "nimbusimage.xenium.cli._connect", lambda: MagicMock()
        )
        code = cli_main(
            [
                "properties",
                "--bundle-dir",
                str(bundle.directory),
                "--dataset",
                "ds_1",
                "--what",
                "genes,bogus",
            ]
        )
        assert code == 1
        assert "unknown --what entries: ['bogus']" in capsys.readouterr().err

    @pytest.mark.parametrize("what", ["", ","])
    def test_empty_what_is_an_error(self, bundle, monkeypatch, capsys, what):
        client = MagicMock()
        monkeypatch.setattr("nimbusimage.xenium.cli._connect", lambda: client)
        code = cli_main(["properties", "--bundle-dir", str(bundle.directory),
                         "--dataset", "ds_1", "--what", what])
        assert code == 1
        assert "--what is empty" in capsys.readouterr().err
        client.dataset.assert_not_called()

    def test_polygons_saves_ids(self, bundle, monkeypatch, tmp_path):
        ds = FakeDataset()
        ds.annotations.count.return_value = 3
        client = MagicMock()
        client.dataset.return_value = ds
        monkeypatch.setattr("nimbusimage.xenium.cli._connect", lambda: client)
        out = tmp_path / "ids.npy"
        assert (
            cli_main(
                [
                    "polygons",
                    "--bundle-dir",
                    str(bundle.directory),
                    "--dataset",
                    "ds_1",
                    "--ids-out",
                    str(out),
                ]
            )
            == 0
        )
        assert np.load(out, allow_pickle=True).tolist() == [
            "ann_0",
            "ann_1",
            None,
            "ann_2",
        ]

    @pytest.mark.parametrize(
        "argv, message",
        [
            (
                ["properties", "--what", "genes", "--genes", "NOPE"],
                "not genes of this panel",
            ),
            (
                ["properties", "--what", "umap", "--umap", "missing.npy"],
                "cannot read",
            ),
            (
                ["cell-types", "--cell-types", "BAD_CSV"],
                "not a cell of this bundle",
            ),
            (["spatial-table", "--umap", "missing.npy"], "cannot read"),
            (
                [
                    "polygons",
                    "--delete-tag",
                    "t",
                    "--alignment",
                    "missing.csv",
                ],
                "cannot read alignment",
            ),
        ],
    )
    def test_bad_local_input_fails_before_server_work(
        self, bundle, monkeypatch, capsys, argv, message
    ):
        """A bad input is reported before any id fetch, upload or delete."""
        bad_csv = bundle.directory / "bad.csv"
        bad_csv.write_text("cell_id,group\npppppppp-9,T cell\n")
        client = MagicMock()
        monkeypatch.setattr("nimbusimage.xenium.cli._connect", lambda: client)
        argv = [str(bad_csv) if a == "BAD_CSV" else a for a in argv]
        code = cli_main(
            argv[:1]
            + ["--bundle-dir", str(bundle.directory), "--dataset", "ds_1"]
            + argv[1:]
        )
        assert code == 1
        assert message in capsys.readouterr().err
        ds = client.dataset.return_value
        ds.annotations.list.assert_not_called()
        ds.annotations.delete_many.assert_not_called()
        ds.annotations.create_many.assert_not_called()

    def test_main_module_import_does_not_run_the_cli(self):
        import importlib

        importlib.import_module("nimbusimage.xenium.__main__")

    def test_missing_credentials(self, monkeypatch):
        for name in ("NI_API_KEY", "NI_TOKEN", "NI_USERNAME", "NI_PASSWORD"):
            monkeypatch.delenv(name, raising=False)
        from nimbusimage.xenium.cli import _connect

        with pytest.raises(XeniumError, match="NI_API_URL"):
            _connect()

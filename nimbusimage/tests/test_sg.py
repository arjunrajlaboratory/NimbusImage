"""Tests for nimbusimage.sg against a synthetic one-ROI export.

The export is built so every file agrees: three square cells drawn in
microns, a tiled label mask at 0.5 um/px, molecules inside and outside the
cells, and a CellxGene matrix that is exactly the mask recount. Each test
then perturbs one thing.
"""

import importlib.util
import json
import sys
import types
import zipfile
from pathlib import Path

import numpy as np
import pytest

zarr = pytest.importorskip("zarr")
tifffile = pytest.importorskip("tifffile")
pd = pytest.importorskip("pandas")
ad = pytest.importorskip("anndata")

from nimbusimage.sg import (  # noqa: E402
    SGCellMap,
    SGError,
    SGRoi,
    build_spatial_table,
    build_transcript_store,
    channel_name,
    check_frame,
    labels_at,
    list_rois,
    recount,
    register_transcripts,
    upload_cell_data,
    upload_polygons,
    upload_spatial_table,
    verify_cells,
    write_transcript_store,
)
from nimbusimage.sg.cli import main as cli_main  # noqa: E402
from nimbusimage.sg.export import find_project_dir  # noqa: E402
from tests.test_xenium import FakeServer  # noqa: E402

PIXEL_SIZE = 0.5
SIZE = 64  # mask is SIZE x SIZE pixels, tiles of 16
# label -> square (x0, y0, x1, y1) in pixels; label 3 crosses a tile seam
SQUARES = {1: (2, 2, 10, 10), 2: (20, 4, 30, 12), 3: (12, 30, 24, 44)}
GENES = ["Spp1", "KRT7", "Tex19.1"]  # '.' must become '_'
LEIDEN = {1: 0, 2: 1}  # cell 3 unclustered


def _write_export(root: Path) -> Path:
    project = root / "DataExport_T" / "T"
    basic = project / "basic_results" / "roi_1"
    mini = project / "mini_project" / "roi_1"
    for d in (basic, mini / "images", mini / "clusters"):
        d.mkdir(parents=True)
    (mini / "sganalysis.session").write_text(
        json.dumps({"res": PIXEL_SIZE, "shape": [SIZE, SIZE]})
    )
    mask = np.zeros((SIZE, SIZE), np.uint32)
    features, coords = [], []
    for label, (x0, y0, x1, y1) in SQUARES.items():
        mask[y0:y1, x0:x1] = label
        um = [(x * PIXEL_SIZE, y * PIXEL_SIZE)
              for x, y in [(x0, y0), (x1, y0), (x1, y1), (x0, y1), (x0, y0)]]
        features.append({
            "type": "Feature", "id": str(label),
            "geometry": {"type": "Polygon", "coordinates": [um]},
            "properties": {"objectType": "cell"},
        })
        coords.append({
            "label": label, "area": (x1 - x0) * (y1 - y0) * PIXEL_SIZE ** 2,
            "center_x": (x0 + x1) / 2 * PIXEL_SIZE,
            "center_y": (y0 + y1) / 2 * PIXEL_SIZE,
        })
    tifffile.imwrite(basic / "roi_1_Segmentation.tiff", mask, tile=(16, 16))
    (basic / "roi_1_Boundaries.geojson").write_text(
        json.dumps({"type": "FeatureCollection", "features": features})
    )
    pd.DataFrame(coords).to_csv(basic / "roi_1_CellCoordinates.csv",
                                index=False)
    rng = np.random.default_rng(1)
    n = 400
    x_px = rng.uniform(0, SIZE, n)
    y_px = rng.uniform(0, SIZE, n)
    gene = rng.integers(0, len(GENES), n)
    molecules = pd.DataFrame({
        "name": [GENES[g] for g in gene],
        "x": np.round(x_px * PIXEL_SIZE, 2),
        "y": np.round(y_px * PIXEL_SIZE, 2),
        "z": 0.0,
    })
    molecules.to_csv(basic / "roi_1_TranscriptList.csv", index=False)
    # the matrix is the floor-assigned recount
    label_of = mask[
        np.floor(molecules.y / PIXEL_SIZE).astype(int),
        np.floor(molecules.x / PIXEL_SIZE).astype(int),
    ]
    matrix = pd.DataFrame(0, index=list(SQUARES), columns=GENES)
    for label, name in zip(label_of, molecules.name):
        if label:
            matrix.loc[int(label), name] += 1
    matrix.to_csv(basic / "roi_1_CellxGene.csv")
    obs = pd.DataFrame(
        {"leiden": pd.Categorical([str(LEIDEN.get(lb, "nan"))
                                   for lb in SQUARES])},
        index=[str(lb) for lb in SQUARES],
    )
    obs.loc[obs.leiden == "nan", "leiden"] = np.nan
    adata = ad.AnnData(
        X=np.zeros((len(SQUARES), len(GENES)), np.float32), obs=obs,
        var=pd.DataFrame({"refids": ["ENS1", "ENS2", "ENS3"]}, index=GENES),
    )
    adata.obsm["X_umap"] = np.array([[1.0, 2.0], [3.0, 4.0], [5.0, 6.0]])
    adata.write_h5ad(mini / "clusters" / "matrix_T_T_cells.h5ad")
    for name in ("dapi.tiff", "GFP_image.tiff"):
        (mini / "images" / name).write_bytes(b"")
    return root


@pytest.fixture
def export(tmp_path) -> Path:
    return _write_export(tmp_path)


@pytest.fixture
def roi(export) -> SGRoi:
    return SGRoi(export, "roi_1")


@pytest.fixture
def server():
    return FakeServer()


def _uploaded(server, roi, dataset_id="ds_sg") -> tuple:
    ds = server.dataset(dataset_id)
    return ds, upload_polygons(ds, roi)


class TestExport:
    def test_finds_the_project_from_parents(self, export):
        project = export / "DataExport_T" / "T"
        for start in (export, export / "DataExport_T", project):
            assert find_project_dir(start) == project
        assert list_rois(export) == ["roi_1"]

    def test_bad_roi_and_missing_files_raise(self, export, roi):
        with pytest.raises(SGError):
            SGRoi(export, "roi_9")
        with pytest.raises(SGError):
            SGRoi(export, "region_1")
        (roi.basic_dir / "roi_1_CellxGene.csv").unlink()
        with pytest.raises(SGError, match="missing"):
            roi.counts()

    def test_session_gives_pixel_size_and_shape(self, roi):
        assert roi.pixel_size == PIXEL_SIZE
        assert roi.shape == (SIZE, SIZE)

    def test_polygons_drop_the_closing_vertex(self, roi):
        labels, rings = roi.polygons()
        assert labels.tolist() == [1, 2, 3]
        assert all(len(ring) == 4 for ring in rings)
        assert rings[0][0].tolist() == [1.0, 1.0]

    def test_channel_names(self, roi):
        assert channel_name(Path("dapi.tiff")) == "DAPI"
        assert channel_name(Path("GFP_image.tiff")) == "GFP"
        assert channel_name(Path("cy5_stain.ome.tif")) == "cy5-stain"
        assert [n for n, _ in roi.image_paths()] == ["DAPI", "GFP"]

    def test_symbols_are_stored_safely(self, roi):
        _, symbols, names, _ = roi.counts()
        assert "Tex19_1" in symbols and "Tex19.1" in names
        gene_names, _, _ = roi.transcripts()
        assert "Tex19_1" in gene_names and "Tex19.1" not in gene_names

    def test_clusters_read_leiden_umap_and_gene_ids(self, roi):
        clusters = roi.clusters()
        assert clusters["labels"].tolist() == [1, 2, 3]
        assert clusters["leiden"].tolist() == [0, 1, -1]
        assert clusters["umap"].shape == (3, 2)
        assert clusters["gene_ids"]["KRT7"] == "ENS2"


class TestVerify:
    def test_labels_at_reads_tiles_like_the_whole_image(self, roi):
        mask = tifffile.imread(roi.segmentation_path)
        rng = np.random.default_rng(0)
        x = rng.integers(-3, SIZE + 3, 500)
        y = rng.integers(-3, SIZE + 3, 500)
        found = labels_at(roi.segmentation_path, x, y)
        inside = (x >= 0) & (x < SIZE) & (y >= 0) & (y < SIZE)
        assert (found[inside] == mask[y[inside], x[inside]]).all()
        assert (found[~inside] == 0).all()

    def test_sample_sizes_must_be_positive(self, server, roi):
        with pytest.raises(SGError, match="sample"):
            check_frame(roi, sample=0)
        ds, cells = _uploaded(server, roi)
        with pytest.raises(SGError, match="sample"):
            verify_cells(ds, roi, cells, sample=0)

    def test_frame_check_passes_and_catches_a_wrong_pixel_size(self, roi):
        assert check_frame(roi)["fraction"] == 1.0
        roi.session["res"] = PIXEL_SIZE * 2
        assert check_frame(roi)["fraction"] < 0.5

    def test_recount_reproduces_the_matrix(self, roi):
        result = recount(roi)
        assert result["entriesEqual"] == 1.0
        assert result["inCells"] == result["matrixTotal"] > 0
        assert result["maxDifference"] == 0


class TestCells:
    def test_polygons_are_pixels_and_the_map_round_trips(
        self, server, roi, tmp_path
    ):
        ds, cells = _uploaded(server, roi)
        assert cells.labels.tolist() == [1, 2, 3]
        first = server.annotations[cells.id_of[2]]
        assert first.coordinates[0] == {"x": 20.0, "y": 4.0}
        assert len(first.coordinates) == 4
        path = cells.save(tmp_path / "cells")
        again = SGCellMap.read(path)
        assert again.id_of == cells.id_of
        assert (again.dataset_id, again.roi, again.pixel_size) == (
            ds.id, "roi_1", PIXEL_SIZE)
        assert verify_cells(ds, roi, again) == 3

    def test_an_unreadable_map_is_an_sg_error(self, tmp_path):
        garbage = tmp_path / "cells.npz"
        garbage.write_bytes(b"not a zip")
        with pytest.raises(SGError, match="not a readable cell map"):
            SGCellMap.read(garbage)
        np.savez(tmp_path / "objects.npz", ids=np.array([{}], dtype=object))
        with pytest.raises(SGError):
            SGCellMap.read(tmp_path / "objects.npz")

    def test_polygon_limit_must_be_positive(self, server, roi):
        ds = server.dataset("ds_sg")
        for limit in (0, -1):
            with pytest.raises(SGError, match="limit"):
                upload_polygons(ds, roi, limit=limit)
        assert server.writes == []
        assert len(upload_polygons(ds, roi, limit=2)) == 2

    def test_a_map_of_another_dataset_or_roi_is_refused(
        self, server, roi, export
    ):
        _, cells = _uploaded(server, roi)
        other = server.dataset("ds_other")
        with pytest.raises(SGError, match="belongs to dataset"):
            upload_cell_data(other, roi, cells)
        renamed = SGCellMap(cells.dataset_id, "roi_2", cells.project,
                            cells.pixel_size, cells.labels, cells.ids)
        writes = len(server.writes)
        with pytest.raises(SGError, match="roi_2"):
            upload_cell_data(server.dataset("ds_sg"), roi, renamed)
        assert len(server.writes) == writes

    def test_verify_catches_a_moved_polygon(self, server, roi):
        ds, cells = _uploaded(server, roi)
        server.annotations[cells.id_of[1]].coordinates[0] = {"x": 0, "y": 0}
        with pytest.raises(SGError, match="label 1"):
            verify_cells(ds, roi, cells)


class TestCellData:
    def test_tags_and_properties(self, server, roi):
        ds, cells = _uploaded(server, roi)
        sizes = upload_cell_data(ds, roi, cells)
        assert sizes == {0: 1, 1: 1}
        tags = {lb: server.annotations[i].tags
                for lb, i in cells.id_of.items()}
        assert tags == {1: ["cell", "Leiden 0"], 2: ["cell", "Leiden 1"],
                        3: ["cell"]}
        area = server.values["prop_SG Area"]
        assert area[cells.id_of[1]] == {"area_um2": 16.0}
        assert server.values["prop_UMAP"][cells.id_of[3]] == {
            "x": 5.0, "y": 6.0}
        clustering = server.values["prop_Clustering"]
        assert clustering == {cells.id_of[1]: {"leiden": 0},
                              cells.id_of[2]: {"leiden": 1}}

    def test_custom_polygon_tags_survive_cell_data(
        self, server, roi, tmp_path
    ):
        ds = server.dataset("ds_sg")
        cells = upload_polygons(ds, roi, tags=["sg-cell"])
        cells = SGCellMap.read(cells.save(tmp_path / "cells.npz"))
        upload_cell_data(ds, roi, cells)
        assert server.annotations[cells.id_of[1]].tags == [
            "sg-cell", "Leiden 0"]
        assert server.annotations[cells.id_of[3]].tags == ["sg-cell"]

    @pytest.mark.parametrize(
        "controls", [{"chunk": 0}, {"chunk": -1}, {"verify_sample": -1}]
    )
    def test_invalid_controls_are_refused_before_any_write(
        self, server, roi, controls
    ):
        ds, cells = _uploaded(server, roi)
        writes = len(server.writes)
        with pytest.raises(SGError):
            upload_cell_data(ds, roi, cells, **controls)
        assert len(server.writes) == writes

    def test_values_are_replaced_not_merged(self, server, roi):
        ds, cells = _uploaded(server, roi)
        upload_cell_data(ds, roi, cells)
        upload_cell_data(ds, roi, cells)
        deletes = [m for _, m in server.writes if m == "delete_values"]
        assert len(deletes) == 6


def _open_zip(path: Path, tmp_path: Path):
    """Version-agnostic read: unzip, then open the directory."""
    directory = tmp_path / (path.name + ".dir")
    with zipfile.ZipFile(path) as zf:
        zf.extractall(directory)
    return zarr.open_group(str(directory), mode="r")


class TestSpatialTable:
    def test_layout(self, server, roi, tmp_path):
        ds, cells = _uploaded(server, roi)
        path = build_spatial_table(roi, cells, tmp_path / "t.zarr.zip")
        directory = tmp_path / "t.dir"
        with zipfile.ZipFile(path) as zf:
            zf.extractall(directory)
            assert ".zgroup" in zf.namelist()  # zarr format 2
        table = ad.read_zarr(directory)
        assert table.obs["annotation_id"].tolist() == [
            cells.id_of[lb] for lb in (1, 2, 3)]
        assert table.obs["cell_type"].tolist() == [
            "Leiden 0", "Leiden 1", "unclustered"]
        assert table.var.index.tolist() == ["Spp1", "KRT7", "Tex19_1"]
        assert table.var["gene_id"].tolist() == ["ENS1", "ENS2", "ENS3"]
        expected = pd.read_csv(roi.counts_path, index_col=0).to_numpy()
        assert (np.asarray(table.X.todense()) == expected).all()
        assert table.uns["nimbus"]["datasetId"] == ds.id
        upload_spatial_table(ds, path)
        with pytest.raises(SGError, match="built for dataset"):
            upload_spatial_table(server.dataset("ds_other"), path)

    def test_a_mapped_cell_without_a_matrix_row_is_refused(
        self, server, roi, tmp_path
    ):
        _, cells = _uploaded(server, roi)
        table = pd.read_csv(roi.counts_path, index_col=0)
        table.drop(index=2).to_csv(roi.counts_path)
        with pytest.raises(SGError, match="no CellxGene row"):
            build_spatial_table(roi, cells, tmp_path / "t.zarr.zip")
        assert not (tmp_path / "t.zarr.zip").exists()


class TestTranscriptStore:
    def test_layout_levels_and_density(self, roi, tmp_path):
        path = build_transcript_store(roi, tmp_path / "tx.zarr.zip")
        root = _open_zip(path, tmp_path)
        names, genes, xyz = roi.transcripts()
        assert list(root.attrs["gene_names"]) == names
        assert root.attrs["nimbus_source"]["roi"] == "roi_1"
        grids = root["grids"]
        assert grids.attrs["number_levels"] == 7
        for level in range(7):
            total = 0
            for key, count in zip(grids.attrs["grid_keys"][level],
                                  grids.attrs["grid_number_objects"][level]):
                tile = grids[str(level)][key]
                offsets = tile["gene_offset"][:]
                identity = tile["gene_identity"][:, 0]
                assert offsets.shape == (len(names), 4)
                for g, (lo0, lo1, hi0, hi1) in enumerate(offsets):
                    assert lo0 == lo1  # no low-quality run
                    assert (identity[hi0:hi1] == g).all()
                if level == 0:
                    assert (tile["quality_score"][:] >= 20).all()
                    total += count
                else:
                    total += int(tile["cluster_count"][:].sum())
            assert total == len(genes), f"level {level} loses molecules"
        density = root["density"]["gene"]
        rows = density.attrs["rows"]
        indptr = density["indptr"][:]
        data = density["data"][:]
        for g in range(len(names)):
            span = slice(indptr[g * rows], indptr[(g + 1) * rows])
            assert data[span].sum() == (genes == g).sum()

    def test_merging_keeps_true_centroids(self, tmp_path):
        xyz = np.array([[1.1, 1.1, 0], [1.3, 1.5, 0], [100, 100, 0]],
                       np.float32)
        path = write_transcript_store(["A"], np.zeros(3, int), xyz,
                                      tmp_path / "m.zarr.zip")
        tile = _open_zip(path, tmp_path)["grids"]["2"]["0,0"]
        counts = tile["cluster_count"][:, 0].tolist()
        location = tile["location"][:]
        merged = location[counts.index(2)]
        assert np.allclose(merged[:2], [1.2, 1.3], atol=1e-5)

    @pytest.mark.parametrize(
        "genes, xyz",
        [
            (np.array([0, 5]), np.zeros((2, 3))),        # gene out of range
            (np.array([0, 0]), np.array([[-1, 0, 0], [1, 1, 0]])),
            (np.array([], int), np.zeros((0, 3))),
        ],
    )
    def test_bad_input_is_refused(self, tmp_path, genes, xyz):
        with pytest.raises(SGError):
            write_transcript_store(["A"], genes, xyz, tmp_path / "x.zip")

    def test_levels_must_be_positive(self, tmp_path):
        with pytest.raises(SGError, match="levels"):
            write_transcript_store(
                ["A"], np.zeros(1, int), np.zeros((1, 3)),
                tmp_path / "x.zarr.zip", levels=0,
            )
        assert not (tmp_path / "x.zarr.zip").exists()

    def test_register_uses_the_map_frame_and_refuses_another_roi(
        self, server, roi, tmp_path
    ):
        ds, cells = _uploaded(server, roi)
        path = build_transcript_store(roi, tmp_path / "tx.zarr.zip")
        register_transcripts(ds, cells, path)
        assert ds.spatial.registered == ("item_tx", PIXEL_SIZE, None)
        other = SGCellMap(ds.id, "roi_2", cells.project, PIXEL_SIZE,
                          cells.labels, cells.ids)
        with pytest.raises(SGError, match="roi_1"):
            register_transcripts(ds, other, path)


SERVER_TRANSCRIPTS = (
    Path(__file__).resolve().parents[2]
    / "devops/girder/plugins/SpatialPlugin/upenncontrast_spatial/server"
    / "transcripts.py"
)


@pytest.mark.skipif(
    not SERVER_TRANSCRIPTS.is_file()
    or int(zarr.__version__.split(".")[0]) >= 3,
    reason="needs the repository's SpatialPlugin and zarr 2 (its reader)",
)
def test_the_server_reads_the_store(roi, tmp_path, monkeypatch):
    """The plugin's own TranscriptStore opens the store and serves points
    and density (girder stubbed: only File is imported)."""
    girder = types.ModuleType("girder")
    models = types.ModuleType("girder.models")
    file_module = types.ModuleType("girder.models.file")
    file_module.File = object
    for name, module in (("girder", girder), ("girder.models", models),
                         ("girder.models.file", file_module)):
        monkeypatch.setitem(sys.modules, name, module)
    spec = importlib.util.spec_from_file_location(
        "sg_server_transcripts", SERVER_TRANSCRIPTS
    )
    server_module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(server_module)
    path = build_transcript_store(roi, tmp_path / "tx.zarr.zip")
    store = server_module.TranscriptStore(str(path), PIXEL_SIZE)
    names, genes, xyz = roi.transcripts()
    assert store.totalPoints == len(genes)
    g = names.index("KRT7")
    total = 0
    for key in store.tileKeys[0]:
        points, slots, quality = store.tilePoints(0, key, [g], 20)
        total += len(points)
        assert (quality >= 20).all()
    assert total == (genes == g).sum()
    grid, _, _ = store.densityGrid([g])
    assert grid.sum() == (genes == g).sum()


class TestCli:
    def test_check_prints_json_and_fails_a_wrong_frame(
        self, export, roi, capsys
    ):
        args = ["check", "--export-dir", str(export), "--roi", "roi_1"]
        assert cli_main([*args, "--recount"]) == 0
        report = json.loads(capsys.readouterr().out)
        assert report["frame"]["fraction"] == 1.0
        assert report["recount"]["entriesEqual"] == 1.0
        session = roi.session_path
        session.write_text(json.dumps({"res": 1.0, "shape": [SIZE, SIZE]}))
        assert cli_main(args) == 1

    def test_inventory(self, export, capsys):
        assert cli_main(["inventory", "--export-dir", str(export),
                         "--count-spots"]) == 0
        (entry,) = json.loads(capsys.readouterr().out)
        assert entry["roi"] == "roi_1"
        assert (entry["cells"], entry["genes"], entry["spots"]) == (3, 3, 400)

    def test_steps_with_a_cell_map_of_another_dataset_write_nothing(
        self, export, roi, server, tmp_path, monkeypatch
    ):
        _, cells = _uploaded(server, roi)
        cells_path = cells.save(tmp_path / "cells.npz")
        monkeypatch.setattr(
            "nimbusimage.sg.cli._connect",
            lambda: types.SimpleNamespace(dataset=server.dataset),
        )
        common = ["--export-dir", str(export), "--roi", "roi_1",
                  "--dataset", "ds_other", "--cells", str(cells_path)]
        writes = len(server.writes)
        assert cli_main(["cell-data", *common]) == 1
        assert cli_main(["spatial-table", *common, "--out",
                         str(tmp_path / "t.zip")]) == 1
        assert cli_main(["transcripts", *common, "--out",
                         str(tmp_path / "x.zip")]) == 1
        assert len(server.writes) == writes
        ok = [*common[:4], "--dataset", "ds_sg", "--cells", str(cells_path)]
        assert cli_main(["cell-data", *ok]) == 0

    def test_unwritable_outputs_fail_before_any_upload_or_build(
        self, export, roi, server, tmp_path, monkeypatch
    ):
        _, cells = _uploaded(server, roi)
        cells_path = cells.save(tmp_path / "cells.npz")
        monkeypatch.setattr(
            "nimbusimage.sg.cli._connect",
            lambda: types.SimpleNamespace(dataset=server.dataset),
        )
        built = []
        monkeypatch.setattr(
            "nimbusimage.sg.ingest.build_transcript_store",
            lambda *a: built.append(a),
        )
        missing = tmp_path / "no-such-dir" / "out.npz"
        roi_args = ["--export-dir", str(export), "--roi", "roi_1",
                    "--dataset", "ds_sg"]
        writes = len(server.writes)
        assert cli_main(["polygons", *roi_args,
                         "--cells-out", str(missing)]) == 1
        assert cli_main(["transcripts", *roi_args, "--cells",
                         str(cells_path), "--out", str(missing)]) == 1
        assert len(server.writes) == writes and not built

    def test_verify_fails_when_the_table_or_transcripts_are_missing(
        self, export, roi, server, tmp_path, monkeypatch, capsys
    ):
        ds, cells = _uploaded(server, roi)
        cells_path = cells.save(tmp_path / "cells.npz")
        monkeypatch.setattr(
            "nimbusimage.sg.cli._connect",
            lambda: types.SimpleNamespace(dataset=server.dataset),
        )
        args = ["verify", "--export-dir", str(export), "--roi", "roi_1",
                "--dataset", ds.id, "--cells", str(cells_path)]
        table = {"nObs": 3, "liveAnnotations": 3}
        transcripts = {"totalPoints": 400, "genes": 3}
        for info, tx, code in [
            (table, transcripts, 0),
            (None, transcripts, 1),
            (table, None, 1),
            ({"nObs": 2, "liveAnnotations": 2}, transcripts, 1),
        ]:
            ds.spatial.info = lambda verify=False, info=info: info
            ds.spatial.transcripts = lambda tx=tx: tx
            assert cli_main(args) == code, (info, tx)
        capsys.readouterr()

    def test_ingest_checks_its_work_dir_before_uploading(
        self, export, tmp_path, monkeypatch
    ):
        connected = []
        monkeypatch.setattr(
            "nimbusimage.sg.cli._connect", lambda: connected.append(1)
        )
        work = tmp_path / "work"
        work.mkdir()
        (work / "roi_1_cells.npz").mkdir()  # an output path that is a dir
        assert cli_main(["ingest", "--export-dir", str(export), "--roi",
                         "roi_1", "--work-dir", str(work)]) == 1
        assert not connected

    def test_missing_credentials_is_an_error_not_a_trace(
        self, export, tmp_path, monkeypatch, capsys
    ):
        for name in ("NI_API_KEY", "NI_TOKEN", "NI_USERNAME", "NI_PASSWORD"):
            monkeypatch.delenv(name, raising=False)
        assert cli_main(["images", "--export-dir", str(export), "--roi",
                         "roi_1", "--name", "x"]) == 1
        assert "NI_API_URL" in capsys.readouterr().err

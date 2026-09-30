"""Load a 10x Xenium spatial-transcriptomics bundle into NimbusImage.

Needs the ``xenium`` extra (``pip install 'nimbusimage[xenium]'``); the UMAP
step also needs ``xenium-umap``. Every step is also a shell subcommand of
``nimbusimage-xenium`` (see :mod:`nimbusimage.xenium.cli`).

Two objects carry what the steps share. ``ImageFrame``: how microns map
onto a dataset's pixels. ``CellMap``: every cell's annotation id, with the
dataset and frame it belongs to — per-cell steps refuse one of another
dataset, of nuclei, or of another bundle.

Example:
    import nimbusimage as ni
    from nimbusimage import xenium

    client = ni.connect()
    bundle = xenium.XeniumBundle("extracted/")
    ds = xenium.upload_morphology(client, bundle, "Lymph node")
    cells = xenium.upload_polygons(ds, bundle)
    cells.save("cells_morph.npz")        # later: xenium.open_cells(ds, ...)
    xenium.upload_gene_panel(ds, bundle, cells, ["CD3E", "MS4A1"])
    xenium.upload_clusters(ds, bundle, cells)
    xenium.upload_cell_types(ds, bundle, cells, "cell_types.csv")
    ds.spatial.upload_and_register(
        xenium.build_spatial_table(bundle, cells, "spatial.zarr.zip"))
    xenium.register_transcripts(ds, bundle, cells.frame)

    # the H&E image: its own frame, its own cell map
    he_frame = xenium.ImageFrame.create(bundle=bundle,
                                        alignment="he_align.csv")
    he_cells = xenium.upload_polygons(he_ds, bundle, he_frame)
"""

from nimbusimage.xenium.bundle import (
    CELL_POLYGON_SET,
    NUCLEUS_POLYGON_SET,
    PROTEIN_SUFFIX,
    XeniumBundle,
    decode_cell_groups,
    decode_cell_id,
)
from nimbusimage.xenium.cells import (
    CellMap,
    fetch_cells,
    open_cells,
    read_frame,
    verify_cells,
)
from nimbusimage.xenium.embedding import compute_umap
from nimbusimage.xenium.errors import XeniumError
from nimbusimage.xenium.geometry import ImageFrame, load_alignment
from nimbusimage.xenium.ingest import (
    REGION_TAG,
    build_spatial_table,
    delete_tagged,
    ensure_property,
    load_embedding,
    region_annotations,
    register_transcripts,
    upload_cell_types,
    upload_clusters,
    upload_gene_panel,
    upload_morphology,
    upload_polygons,
    upload_regions,
    upload_umap,
)

__all__ = [
    "CELL_POLYGON_SET",
    "NUCLEUS_POLYGON_SET",
    "PROTEIN_SUFFIX",
    "REGION_TAG",
    "CellMap",
    "ImageFrame",
    "XeniumBundle",
    "XeniumError",
    "build_spatial_table",
    "compute_umap",
    "decode_cell_groups",
    "decode_cell_id",
    "delete_tagged",
    "ensure_property",
    "fetch_cells",
    "load_alignment",
    "load_embedding",
    "open_cells",
    "read_frame",
    "region_annotations",
    "register_transcripts",
    "upload_cell_types",
    "upload_clusters",
    "upload_gene_panel",
    "upload_morphology",
    "upload_polygons",
    "upload_regions",
    "upload_umap",
    "verify_cells",
]

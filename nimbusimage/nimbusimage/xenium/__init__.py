"""Load a 10x Xenium spatial-transcriptomics bundle into NimbusImage.

Needs the ``xenium`` extra (``pip install 'nimbusimage[xenium]'``); the UMAP
step also needs ``xenium-umap``. Every step is also a shell subcommand of
``nimbusimage-xenium`` (see :mod:`nimbusimage.xenium.cli`).

Example:
    import nimbusimage as ni
    from nimbusimage import xenium

    client = ni.connect()
    bundle = xenium.XeniumBundle("extracted/")
    ds = xenium.upload_morphology(client, bundle, "Lymph node")
    ids = xenium.upload_polygons(ds, bundle)          # cell_index order
    xenium.upload_gene_panel(ds, bundle, ids, ["CD3E", "MS4A1"])
    xenium.upload_clusters(ds, bundle, ids)
    xenium.upload_cell_types(ds, bundle, ids, "cell_types.csv")
    table = xenium.build_spatial_table(bundle, ids, "spatial.zarr.zip",
                                       dataset_id=ds.id)
    ds.spatial.upload_and_register(table)
    xenium.register_transcripts(ds, bundle)
"""

from nimbusimage.xenium.bundle import (
    CELL_POLYGON_SET,
    NUCLEUS_POLYGON_SET,
    PROTEIN_SUFFIX,
    XeniumBundle,
    decode_cell_groups,
    decode_cell_id,
)
from nimbusimage.xenium.embedding import compute_umap
from nimbusimage.xenium.errors import XeniumError
from nimbusimage.xenium.geometry import (
    inverse_alignment,
    load_alignment,
    microns_to_pixels,
    region_transform,
)
from nimbusimage.xenium.ingest import (
    REGION_TAG,
    build_spatial_table,
    cell_indices_with_annotations,
    delete_tagged,
    ensure_property,
    fetch_annotation_ids,
    load_annotation_ids,
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
    "XeniumBundle",
    "XeniumError",
    "build_spatial_table",
    "cell_indices_with_annotations",
    "compute_umap",
    "decode_cell_groups",
    "decode_cell_id",
    "delete_tagged",
    "ensure_property",
    "fetch_annotation_ids",
    "inverse_alignment",
    "load_alignment",
    "load_annotation_ids",
    "microns_to_pixels",
    "region_annotations",
    "region_transform",
    "register_transcripts",
    "upload_cell_types",
    "upload_clusters",
    "upload_gene_panel",
    "upload_morphology",
    "upload_polygons",
    "upload_regions",
    "upload_umap",
]

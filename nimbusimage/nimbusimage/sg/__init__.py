"""Load a Spatial Genomics (GenePS / sganalysis) data export into
NimbusImage, one ROI per dataset.

Needs the ``sg`` extra (``pip install 'nimbusimage[sg]'``). Every step is
also a shell subcommand of ``nimbusimage-sg`` (see
:mod:`nimbusimage.sg.cli`).

The cell label is the join key of the export; ``SGCellMap`` records which
annotation each label became, with the dataset, ROI and pixel size, and
every later step refuses a map of another dataset or ROI.

Example:
    import nimbusimage as ni
    from nimbusimage import sg

    roi = sg.SGRoi("DataExport_Pav", "roi_3")
    print(sg.check_frame(roi))              # centroids on their own label
    client = ni.connect()
    ds = sg.upload_images(client, roi, "Pav_PTR roi_3")
    cells = sg.upload_polygons(ds, roi)
    cells.save("roi_3_cells.npz")           # later: sg.SGCellMap.read(...)
    sg.upload_cell_data(ds, roi, cells)     # Leiden tags, area, UMAP
    table = sg.build_spatial_table(roi, cells, "spatial.zarr.zip")
    sg.upload_spatial_table(ds, table)
    store = sg.build_transcript_store(roi, "transcripts.zarr.zip")
    sg.register_transcripts(ds, cells, store)
"""

from nimbusimage.sg.cells import SGCellMap, verify_cells
from nimbusimage.sg.errors import SGError
from nimbusimage.sg.export import SGRoi, channel_name, list_rois
from nimbusimage.sg.ingest import (
    build_spatial_table,
    build_transcript_store,
    register_transcripts,
    upload_cell_data,
    upload_images,
    upload_polygons,
    upload_spatial_table,
)
from nimbusimage.sg.transcripts import write_transcript_store
from nimbusimage.sg.verify import check_frame, labels_at, recount

__all__ = [
    "SGCellMap",
    "SGError",
    "SGRoi",
    "build_spatial_table",
    "build_transcript_store",
    "channel_name",
    "check_frame",
    "labels_at",
    "list_rois",
    "recount",
    "register_transcripts",
    "upload_cell_data",
    "upload_images",
    "upload_polygons",
    "upload_spatial_table",
    "verify_cells",
    "write_transcript_store",
]

## Supported File Formats
NimbusImage works with most common microscopy formats without conversion:
- **Nikon (.nd2)**: Works out-of-box with automatic variable assignment
- **Zeiss (.czi)**: Fully supported with automatic transcoding for better performance
- **Leica (.lif)**: Imports the largest image set from the container
- **TIFF/OME-TIFF**: Supports single files and multi-file datasets
- **Multi-file datasets**: Automatically detects variables from filenames (e.g., `GFP_s001_t002.tif`)

For special cases:
- Multi-file OME-TIFFs can be converted using `large_image_converter`
- IncuCyte TIFFs may require pre-processing with the NimbusImage script

## Uploading Data
Start from the home page: drag files or a whole folder onto the **Upload files** area, click **Upload a folder** to pick one, or use the **Upload Data** button. A **Create Dataset** dialog then lets you name the dataset, pick a storage location (Private/Public/Team), and choose how to import.

**One multi-file dataset (the default)**:
- Multiple files — or a dropped folder — become a **single multidimensional dataset**. NimbusImage parses channels, Z, time, and position from metadata or filenames (e.g. `s01`, `t02`). This is what you want for "a folder's worth of images" that belong to one acquisition.
- Use **Quick Import** to accept defaults and go straight to the viewer, or **Advanced Import** to review and adjust:
  1. **Variable assignment** — map filename elements (`s01`, `t02`, …) to Z, time, channel, or position.
  2. **Compositing** — stitch tiled stage positions together, or keep them as separate positions.
  3. **Transcoding** — "Transcode to optimized TIFF" for better performance. Generally not needed for Nikon .nd2; on by default for Zeiss .czi and for TIFFs. For Leica .lif, NimbusImage imports the largest image set in the container.
  4. **Collection placement** — add the dataset to an existing or new collection.
- The dataset name defaults from the common part of the filenames; the system checks for and prevents duplicate names.

**One dataset per file (a collection)**:
To keep each file as its own dataset (e.g. one file per well or condition) instead of merging them:
1. In the Create Dataset dialog, check **"Upload each file as a separate dataset in a collection"** (available once 2+ files are selected). The name field becomes **Collection Name**.
2. Each file becomes its own dataset, all grouped into a new collection that shares visualization settings and tools. You can edit each per-file dataset name.
3. **Quick Import** processes every file with default settings; **Advanced Import** lets you configure dimension settings on the first dataset, which are then applied to all the rest.
4. The system checks for duplicate names before uploading, and after import flags any files whose dimensions or channels don't match.

This collection path is ideal for experiments where you have many separate image files (e.g., one per well or condition) that you want to analyze together with consistent settings.

**Bulk Collection Export**:
- Export all annotations and property data from an entire collection at once
- Useful for exporting results from a multi-dataset experiment in one step


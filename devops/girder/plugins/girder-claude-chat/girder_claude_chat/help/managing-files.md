# 4. Managing Files

## File Management System
NimbusImage provides a robust file management system to organize datasets, collections, and other files. The interface includes:
- **Upload dataset** area for adding new data
- **Recent datasets** section showing recently accessed datasets
- **File navigator** for browsing folders and files
- **Action buttons** to create folders, upload files, and perform other operations

## Uploading Data
From the home page, drag files — or a whole folder — onto the **Upload files** area, click the **Upload a folder** button to pick a folder, or use the **Upload Data** button. After you select files, a **Create Dataset** dialog opens where you name the dataset, choose a storage location (Private, Public, or Team folder), and choose how to process it.

**One dataset from many files (the default)**:
- When you drop a folder or select multiple files, they all become **one multi-file dataset** by default.
- NimbusImage automatically parses dimensions — channels, Z-slices, timepoints, and positions — from the file metadata or from the filenames (e.g. `GFP_s001_t002.tif`).
- This is the right choice for "a folder's worth of images" that together form a single acquisition (a Z-stack, a time lapse, a multi-position scan, etc.).
- Files from a folder are flattened (nested subfolders are included) and added in natural, numeric-aware name order.

**Quick Import vs. Advanced Import**:
- **Quick Import** processes with default settings and takes you straight to the viewer — best for getting started fast.
- **Advanced Import** lets you review and adjust how filename elements map to variables (channel, Z, time, position), compositing/tiling of stage positions, transcoding, and collection placement before processing.

**Uploading each file as its own dataset (a collection)**:
- If instead each file is a separate sample (e.g. one file per well or condition), check **"Upload each file as a separate dataset in a collection"** in the Create Dataset dialog. (This option only appears once you have selected 2 or more files.)
- This creates a **collection** — a group of datasets that share the same visualization settings and tools — with one dataset per file. The name field becomes **Collection Name**, and you can edit each per-file dataset name.
- Configure the first dataset (via Advanced Import) and those dimension settings are applied automatically to the rest. NimbusImage checks for duplicate names and warns you if files have mismatched dimensions or channels.

## Storage Organization
NimbusImage provides specific locations for storing datasets and files:
- **Private folder**: Only accessible to you
- **Public folder**: Accessible to everyone using the system
- **Team folder**: (NimbusImage.com specific) Shared only with team members

New folders can be created within these storage locations to organize datasets.

## File Operations
Several operations can be performed on files and datasets:
- **Move**: Relocate files to different folders
- **Delete**: Remove files or datasets
- **Rename**: Change the name of files or datasets
- **Browse**: For datasets, view internal files (use with caution)

Multiple files can be managed at once by selecting checkboxes and using the "Actions" menu.

## Best Practices
- Use meaningful names for datasets and collections
- Create folders to organize related datasets
- Keep the file structure simple for easier navigation
- Use private folders for work in progress
- Move to team folders when ready to collaborate


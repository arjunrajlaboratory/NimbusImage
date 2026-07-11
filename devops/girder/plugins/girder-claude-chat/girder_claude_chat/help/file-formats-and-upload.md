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
NimbusImage provides a streamlined "Create Dataset" dialog to upload your data:

**Accessing Upload Options**:
- Click the upload button on the home page to open the Create Dataset dialog
- The dialog offers both quick and advanced upload options in one place

**Quick Upload**:
- Simply drag and drop files onto the upload zone
- NimbusImage automatically processes with default settings
- Best for simple datasets and quick exploration

**Advanced Upload**:
1. **Dataset Name**: Enter a name for your dataset (the system checks to prevent duplicate names)
2. **Storage Location**: Choose where to save the dataset (Private, Public, or Team folder)
3. **File Selection**: Upload your image files
4. **Variable Assignment**: Map filename elements (s01, t02, etc.) to variables
5. **Compositing Options**: Choose to stitch tiles or keep as separate positions
6. **Transcoding**: Optimize performance by transcoding to efficient TIFF. Not generally needed for Nikon .nd2 files, but important for Leica .lif and Zeiss .czi files.
7. **Collection Assignment**: Add to existing or create new collection

**Batch Dataset Upload**:
Upload multiple files at once, creating one dataset per file in a single collection:
1. Enable "Batch Dataset Mode" checkbox in the upload dialog
2. Drag and drop multiple image files (e.g., multiple .nd2 or .czi files)
3. Each file becomes its own dataset, all grouped in a new collection
4. **Quick Import**: Processes all files with default settings
5. **Advanced Import**: Configure dimension settings on the first file, and those settings apply to all subsequent files. NimbusImage highlights the variable portions of filenames to help you understand how variables are being assigned.
6. The system checks for duplicate filenames before uploading
7. After import, you'll see a compatibility check—if files have different dimensions or channels, you'll be warned about which aspects don't match

This is ideal for experiments where you have many separate image files (e.g., one per well or condition) that you want to analyze together in a single collection.

**Bulk Collection Export**:
- Export all annotations and property data from an entire collection at once
- Useful for exporting results from a multi-dataset experiment in one step


# 9. Common Workflows

## Cell Segmentation & Analysis

**Basic Cell Segmentation Workflow**: This workflow now uses Cellpose-SAM, the recommended tool.
1. **Segment Nuclei (or Cells directly)**:
   - Create a Cellpose-SAM tool.
   - For nuclei: Provide the nuclear stain to "Channel for Slot 1". Tag objects as "nucleus".
   - For cells (single channel): Provide the cytoplasm/membrane channel to "Channel for Slot 1". Tag objects as "cell".
   - For cells (dual channel for better results): Provide cytoplasm/membrane to "Channel for Slot 1" and nuclear channel to "Channel for Slot 2". Tag objects as "cell".
   - Set "Model" to `cellpose-sam` (usually default).
   - Set "Diameter" to an approximate size (e.g., 30 pixels). Cellpose-SAM is less sensitive to this than legacy Cellpose.
   - Adjust "Smoothing" (e.g., 0.7) and other parameters as needed.
   - Run compute and review results.
   
2. **Measure Nuclear/Cell Properties**:
   - Create Blob metrics property for the tag used (e.g., "nucleus" or "cell").
   - Run the worker to calculate area, shape metrics.
   - Create Blob intensity property for fluorescence channels of interest.
   - Filter by area to remove artifacts if necessary.

3. **Add Missing or Remove False Objects** (if needed):
   - Use Manual blob or Segment Anything Model for individual missed objects.
   - Use Segment Similar Objects when the user can show a few examples and wants NimbusImage to find many more similar objects in the current view.
   - Shift-select and delete false positives.
   
4. **Segment Cell Bodies from Nuclei (if nuclei were segmented first)** (optional):
   - This step is often not needed if cells were segmented directly with Cellpose-SAM using cytoplasmic and nuclear channels.
   - If you segmented nuclei first and need to find surrounding cell bodies:
     - Create another Cellpose-SAM tool, this time for "cell" objects.
     - Use the cytoplasm channel in "Channel for Slot 1" and the DAPI/nuclear channel in "Channel for Slot 2".
     - Adjust diameter for cell size.
     - Connect nuclei to cells with Connect to Nearest if distinct "nucleus" and "cell" objects were created.

5. **Export Measurements**:
   - Select desired properties in Object list.
   - Export to CSV for further analysis.

## Finding Similar Objects by Example

Use this workflow when the user has a visually recognizable object class but cannot easily describe it with a fixed threshold, diameter, or conventional segmentation model.

1. **Create the tool**:
   - Add the Segment Similar Objects tool from the toolset.
   - Choose the output tag for accepted objects.
   - Remind users to use Chrome if the tool reports that WebGPU is unavailable.

2. **Provide examples**:
   - Start with foreground examples using SAM Click, SAM Box, or Circle.
   - Add 2-5 clean examples when possible.
   - Add background examples if the tool is picking up a confusing look-alike structure.

3. **Choose how to find matches**:
   - Start with **SAM** for visually distinctive objects.
   - Try **Classifier** for small or textured objects, or when SAM similarity misses too much.
   - Try **SAM->Classifier** when SAM gets a useful first pass and the classifier should refine or generalize from it.

4. **Tune and accept**:
   - Adjust the similarity threshold and size range while watching the putative outlines.
   - Use box prompts for touching objects or grid/thorough prompts when point prompts miss objects.
   - Click Accept only after visually checking the proposed objects.

5. **Cover a large image**:
   - The tool works on the current viewport. Users can accept results, pan or zoom to another area, and repeat.
   - If matching gets worse after a large zoom change, advise adding examples at the current zoom level.

## RNA Spot Counting

**Per-Cell RNA Quantification**:
1. **Segment Cells**:
   - Use Cellpose as described above for cell/nucleus segmentation
   
2. **Detect RNA Spots**:
   - Create Piscis tool with tag "RNA"
   - Set channel to RNA fluorescence channel
   - Choose appropriate model (default or more specific)
   - For 3D data, select "Z-stack" mode
   - Run compute and review results

3. **Count Spots Per Cell**:
   - Option 1 (Physical containment):
     - Create Blob point count property for cell objects
     - Ensure "Count points across all z-slices" is enabled for 3D
     
   - Option 2 (Nearest assignment):
     - Create Connect to Nearest tool to connect spots to nearest cell
     - Use Count children property to count connections

4. **Quality Control**:
   - Filter cells by size/shape to remove partial cells
   - Check spot detection in high/low-expressing cells
   - Review z-slices to ensure proper counting

## 3D Analysis

**Working with Z-Stacks**:
1. **Optimize Z-Stack Visualization**:
   - Adjust contrast for each channel
   - Use Z-slider to navigate through stack
   
2. **3D Spot Detection**:
   - Create Piscis tool and select "Z-stack" mode
   - Run compute to detect spots across entire volume
   - This prevents double-counting spots visible in multiple Z-planes
   
3. **Interact with 3D Data**:
   - Draw objects on any Z-plane
   - Count across Z-planes with "Count points across all z-slices" option
   - Use maximum intensity projections for visualization (Layer → Advanced options)
   - For a true interactive 3D volume rendering (rotate, zoom, view segmentations as extruded shapes), use the 3D Volume Rendering view—see "3D Volume Rendering" in the Visualization section

4. **3D Measurements**:
   - Distance measurements consider Z-dimension when "Measure across Z" is enabled
   - Intensity measurements can use Z-projection methods

## Time Lapse Tracking

**Cell Tracking and Analysis**:
1. **Enable Time Lapse Mode**:
   - Check "Time lapse mode" in navigation panel
   - Adjust track window to control visualization span
   
2. **Segment Cells Across Time**:
   - Create Cellpose tool with appropriate tag
   - Use batch time processing to segment all frames
   
3. **Connect Tracks**:
   - Create Connect timelapse tool
   - Set max distance based on cell movement speed
   - Set connect across gaps if cells disappear temporarily
   - Run compute to create tracks
   
4. **Fix Tracking Errors**:
   - Create Lasso connect tool to repair broken tracks
   - Circle sequential objects in time to connect them
   - Use Lasso disconnect to remove incorrect connections
   
5. **Measure Through Time**:
   - Create desired property workers (intensity, area)
   - Create Parent and child property to capture lineage information
   - Export to CSV with time and track information included

## Point Assignment to Structures

**Associating Points with Structural Features**:
1. **Create Structural Objects**:
   - Segment nuclei, cells, tissue boundaries as needed
   
2. **Create Point Objects**:
   - Detect spots using Piscis or manual point tools
   
3. **Connect Points to Structures**:
   - Method 1: Distance-based assignment
     - Create Connect to nearest tool
     - Set parent tag (structure) and child tag (points)
     - Configure maximum distance and connection type
     
   - Method 2: Region-based assignment
     - Use Blob point count property to count points within structures
     
   - Method 3: Hybrid approach
     - First connect points to nearest structure
     - Then count connected children per structure
     
4. **Analyze Spatial Distributions**:
   - Measure distances from points to structures
   - Calculate densities (points per area)
   - Compare distributions between experimental conditions

These workflows can be combined and customized to address the specific needs of your experiment, with NimbusImage's flexible tagging and connection system allowing for complex analysis pipelines.


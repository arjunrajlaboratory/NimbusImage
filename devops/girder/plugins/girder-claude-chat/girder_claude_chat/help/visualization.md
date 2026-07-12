# 10. Visualization

## Contrast Adjustment
Control how your image data is displayed:

**Adjusting Contrast**:
- Click the palette icon in bottom left corner
- Drag histogram endpoints to set black/white points
- Changes affect display only, not raw data
- Adjustments are linear and suitable for publication

**Contrast Controls**:
- Toggle between **Percentile** and **Absolute** modes for how the black/white points are specified
- **Reset** — reset the points to the histogram limits
- **Revert to saved** — return to the last saved points
- **Save** — save the current points for this layer

**Channel-Specific Settings**:
- Each channel has independent contrast controls
- Settings persist across image navigation

## Layer Management
Customize visualization with flexible layer controls:

**Basic Controls**:
- Toggle layers on/off with channel buttons
- Change channel colors with color picker
- Rename layers for clearer organization

**Custom Color Preferences**:
- Set your default channel colors via the Settings panel (gear icon in the top bar) → "Customize default channel colors"
- Custom colors automatically apply to new datasets
- Preferences are saved to your account and persist across sessions
- Override on a per-dataset basis when needed

**Advanced Options**:
- Create new layers via the "Add layer" button
- Assign any channel to any layer
- Show different time points in different layers:
  1. Create new layer showing same channel
  2. Open Advanced options
  3. Set Time-Slice offset (e.g., +1 for next frame)
  4. Useful for visualizing movement

**Layer Grouping**:
- Drag layers to "Drop zone" to create groups
- Grouped layers toggle together
- Drag layers out of group to separate
- Ideal for multi-channel overlays you frequently use

**Unrolling Layers**:
- Click "Unroll" next to Layers to view channels as montage
- Shows all channels simultaneously for comparison

## 3D Volume Rendering
NimbusImage can render your image stack as an interactive 3D volume instead of a flat 2D slice:

**Switching Between 2D and 3D**:
- Click the cube icon in the top app bar to toggle between the standard 2D viewer and the 3D volume view
- Your layers, annotations, and tools are unaffected when switching back to 2D

**What You See in 3D**:
- Each currently visible channel/layer is rendered as its own semi-transparent volume, colored to match that layer's assigned color—multi-channel overlays work in 3D just as in 2D
- Objects can be overlaid in 3D as "Segmentations": polygon and rectangle objects appear as extruded prisms, lines as vertical ribbons, and points as spheres. Segmentations are colored by tag or by a computed property and honor your current annotation filters

**Depth Axis: Z vs. Time**:
- A two-button toggle at the left of the 3D toolbar sets what the volume's "depth" dimension represents:
  - **Z** (z-axis icon): the depth axis is your z-stack, giving a true 3D reconstruction of the sample at the current timepoint
  - **Clock icon**: the depth axis is Time instead of Z, so a timelapse is displayed as a spatial volume—the current z-slice is held fixed and successive timepoints are stacked like slices of a volume. This is only enabled for datasets with more than one timepoint
- When Time is selected as the depth axis, an extra button (up/down arrows icon) opens a "Time depth spacing" dialog. Since time doesn't have a physical depth, this dialog lets you set how many micrometers apart each timepoint should appear (defaults to 5× the pixel size, but you can enter a custom value, or "Reset to default")

**Toolbar Buttons**:
- **Depth axis toggle** (z-axis / clock icons): switch between Z and Time as the volume's depth dimension, as above
- **Time depth spacing** (up/down arrow icon, only shown when Time is the depth axis): opens the spacing dialog described above
- **Blend mode toggle** (layers icon / bell-curve icon): controls how overlapping voxels along each viewing ray are combined
  - **Composite**: normal semi-transparent volume blending, good for seeing overall 3D shape and structure
  - **Maximum intensity**: shows only the brightest voxel along each ray (a live, rotatable maximum-intensity projection)—good for sparse bright objects like spots, since dim surrounding signal doesn't obscure them
- **Volume** (cube icon): show/hide the rendered image volume itself
- **Segmentations** (polygon icon): show/hide the 3D annotation overlay
- **Loft surfaces** (on by default): join the outlines of the same object on adjacent slices into smooth, shaded surfaces, so a segmented cell reads as a continuous 3D shape rather than a stack of slabs; a dialog sets the overlap threshold controlling how much two outlines must overlap to be joined
- **Reset camera** (fit-to-page icon): reframes the view to fit the current volume
- **Orientation axes** (axis-arrow icon): toggles a small XYZ orientation gizmo in the bottom-right corner that rotates with the camera, so you can always tell which way is up
- **Scaled bounding box** (grid icon): toggles a box with micrometer-labeled tick marks around the volume, useful for judging physical scale
- **Segmentation color mode toggle** (tag icon / scatter-plot icon): choose whether 3D segmentations are colored by tag or by a computed property; selecting "property" reveals a dropdown to pick which property to color by

**Navigation Controls**:
- Rotate: click and drag
- Zoom: scroll wheel
- Pan: right-click/shift-drag

**Contrast in 3D**:
- Percentile-based contrast is computed by sampling across the entire volume rather than a single slice, so the display stays stable while rotating or scrubbing through the volume—contrast may therefore look slightly different from the 2D view at any single slice

**Performance Notes for Large Data**:
- To keep rendering responsive, very large volumes are automatically downsampled: deep z-stacks or long timelapses are capped to a fixed number of planes (subsampled evenly if the stack is deeper), and very high-resolution images are reduced in XY as well
- This means the 3D view may show lower resolution than the full-resolution 2D view for very large datasets—this is expected, not an error
- 3D rendering relies on the browser's WebGL support; use Chrome for best compatibility

## Line Scan Intensity Profiles
Draw a line across the image to see a live plot of raw pixel intensity along it — without creating any stored annotation. Useful for inspecting signal profiles, comparing channels, checking colocalization, or finding edges and peaks.
- Add a **line scan tool** from the tool menu. Two variants: **Freehand** (drag to draw a freeform line; the scan completes on release) and **Segment** (click once to start and once to end a straight segment).
- As you draw, a panel appears at the bottom right with one colored trace per channel (matching each layer's color) and a legend; hover to read the intensity at a position.
- Intensities are the raw, unstyled pixel values (not the contrast-adjusted display), so they are suitable for quantitative comparison.
- When creating the tool you can optionally pick a single channel to plot; the panel can then toggle between all visible channels and just that one. Close the panel to dismiss the scan.

## Snapshots
Create, manage, and export visual bookmarks:

**Creating Snapshots**:
1. Navigate to desired view and adjust contrast
2. Open Snapshots tab in top bar
3. Position red frame around region of interest
   - "Set frame to current viewport" captures current view
   - "Set frame to maximum" includes entire field
4. Click "Save as snapshot"
5. Add name, tags, and description

**Managing Snapshots**:
- Click on saved snapshots to return to that view
- Edit or delete snapshots as needed
- Add tags for organization
- Use as visual documentation of analysis regions
- Select individual snapshots using checkboxes for targeted operations

**Scale Bar Options**:
- Enable scale bar with checkbox
- Configure units, length, and color
- Options for automatic or manual sizing
- Appears in exported images

## Exporting Images
Share visual results for presentations and publications:

**Snapshot Image Export**:
- Under Snapshots tab, select download options:
  - Scaled layers (with contrast adjustments)
  - Raw channels (original pixel values)
  - Format: PNG, JPEG, or TIFF
  - Individual layers or composite

**Download Options**:
- Single image: "Download images for current location"
- Selected snapshots: Select specific snapshots and download only those
- All snapshots: "Download images for all snapshots"
- With annotations: "Download screenshot of current viewport"

**Time-Lapse Movie Export**:
- Configure time range and frame rate
- Add optional time stamp with customizable units (hours, minutes, seconds, etc.)
- Export formats:
  - Image sequence (zipped)
  - Animated GIF
  - Movie file (WebM or MP4)

**Best Practices**:
- Use snapshots to document exact source of figures
- Include scale bars for proper size reference
- Export both processed and raw data for transparency
- Consider using screenshots to include annotations

The combination of visualization tools and export options ensures both effective data exploration and straightforward sharing of results for collaboration and publication.


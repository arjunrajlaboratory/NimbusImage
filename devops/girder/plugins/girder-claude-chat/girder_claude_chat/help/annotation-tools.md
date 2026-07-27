# 5. Objects & Annotation Tools

## Manual Tools
Create objects by hand with simple drawing tools:

**Manual Blob**:
- Draw outlines around structures like cells or tissues
- Click to place vertices, double-click to complete
- Can be edited after creation

**Manual Point**:
- Place markers at specific locations
- Single click to create
- Ideal for spots, centers, or landmarks

**Manual Line**:
- Create paths or boundaries
- Click to place vertices, double-click to end
- Useful for tracking filaments or borders

**Manual Rectangle**:
- Define rectangular regions of interest
- Click and drag to draw
- Useful for training regions or crop areas

**Manual Circle**:
- Create circular annotations
- Click one corner and drag to the opposite corner of the bounding box (the circle is constrained to a square)
- Useful for marking round structures

**Manual Ellipse**:
- Create elliptical annotations
- Click one corner and drag to the opposite corner of the bounding box
- Useful for marking oval structures

## Automated Tools
Leverage algorithms to find objects automatically:

**Cellpose-SAM**:
- Advanced deep learning tool for cell and nucleus segmentation. This is the **recommended method** for most segmentation tasks, offering superior performance to the legacy Cellpose tool.
- **How it works**: Cellpose-SAM processes images by taking input from up to three configurable channel "slots":
    - **Single Channel Input**:
        - To segment nuclei, provide the nuclear stain channel to Slot 1.
        - To segment cell boundaries, provide the cytoplasm/membrane channel to Slot 1.
    - **Dual Channel Input**: For improved cell boundary segmentation, you can provide the cytoplasm/membrane channel to Slot 1 and the nuclear channel to Slot 2.
    - **Triple Channel Input (RGB)**: To segment cells in an RGB image, map the Red, Green, and Blue channels to Slots 1, 2, and 3 respectively.
- **Available models**:
    - **cellpose-sam**: This is the base model and should be suitable for most general-purpose cell segmentation tasks.
- **Key parameters**:
    - **Model**: Selects the segmentation model. Defaults to `cellpose-sam`.
    - **Channel for Slot 1**: **Required.** The primary channel for segmentation. Select the source channel for the model's first input. If multiple are selected, only the first will be used.
    - **Channel for Slot 2**: (Optional) The secondary channel, often used for nuclear information when segmenting cytoplasm. If multiple are selected, only the first will be used.
    - **Channel for Slot 3**: (Optional) The tertiary channel, typically used for the blue channel in RGB images. If multiple are selected, only the first will be used.
    - **Diameter**: The approximate diameter of the cells in pixels. While important for original Cellpose, Cellpose-SAM is less sensitive to this parameter. A value around **30 pixels** often works well as a starting point, but can be adjusted (0-200 pixels, default 10).
    - **Smoothing**: Controls the simplification of the generated polygons (0-10, default 0.7). Higher values create smoother outlines. A value of 0.7 is a good default.
    - **Padding**: Expands (positive values) or contracts (negative values) the final polygons in pixels (-20 to 20 pixels, default 0).
    - **Tile Size**: The size of image tiles (in pixels) for processing (0-2048, default 1024). Larger tiles require more memory.
    - **Tile Overlap**: The fractional overlap between adjacent tiles (0-1, default 0.1). Ensure this overlap is larger than your largest cells (e.g., for 1024px tiles with 0.1 overlap, objects should be <102px).
- **Best practices**:
    1.  **Channel Selection**:
        *   For nuclei: Use your nuclear stain in Slot 1.
        *   For cell boundaries: Use your cytoplasm/membrane channel in Slot 1. Consider adding a nuclear channel to Slot 2 for refinement.
        *   For RGB images: Map R, G, B to Slots 1, 2, and 3.
    2.  **Diameter Setting**: Start with a diameter around 30 pixels. Adjust if necessary, but exact precision is less critical than with standard Cellpose.
    3.  **Review Results**: Always visually inspect segmentation and adjust parameters if needed.
    4.  **Post-process**: Utilize NimbusImage's manual editing tools to correct any segmentation errors.
- Can be retrained on your data for improved performance (see Retraining Models).

**(Legacy) Cellpose**:
- Deep learning tool for cell and nucleus segmentation. **Note: Cellpose-SAM is now the recommended tool for most segmentation tasks.**
- Models: cyto3 (general), nuclei (nuclear staining)
- Key parameters: Primary channel, diameter, smoothing.
- Can be retrained on your data for improved performance.

**Piscis**:
- Specialized for spot detection in fluorescent images
- Ideal for RNA FISH, vesicles, synaptic puncta
- Modes: Current Z (2D) or Z-Stack (3D)
- Multiple pre-trained models with varying sensitivity

**StarDist**:
- Alternative deep learning segmentation for nuclei and cells
- Models: 2D_versatile_fluo, 2D_versatile_he
- Complementary to Cellpose—try both for your data

**CondensateNet**:
- Deep learning tool for detecting and segmenting biomolecular condensates in brightfield microscopy images
- Uses a Feature Pyramid Network (FPN) architecture with EfficientNet encoder
- Key parameters:
  - Probability threshold (0–1, default 0.15): Lower values detect more condensates including faint ones
  - Min/Max Size: Filter by condensate size in pixels
  - Smoothing, Padding: Control polygon output shape
  - Tile Size and Tile Overlap for large images
- Best practice: Adjust probability threshold as the primary tuning parameter

**Laplacian of Gaussian**:
- Classical spot detection algorithm
- Adjustable parameters for spot size and thresholds
- Useful for well-defined, high-contrast spots

## Semi-Automated Tools
Combine automation with user guidance:

**Segment Anything Model (SAM)**:
- Powerful interactive segmentation ("God Mode")
- Hover to preview segmentation, shift-click to select
- Shift-drag to define a bounding box for complex objects
- Works best when objects are clearly visible with good contrast

**Segment Similar Objects**:
- Interactive example-based segmentation tool for finding many objects that look like one or more examples the user provides. This is the tool to recommend when the user says "find more like this," "segment similar objects," "few-shot segmentation," or has objects that are visually recognizable but hard to capture with fixed thresholds.
- Requires Chrome/WebGPU because it uses SAM embeddings. If WebGPU is unavailable, suggest Chrome and fall back to manual tools, plain SAM, or Cellpose-SAM depending on the task.
- How users select examples:
  - **Click (SAM)**: shift-click an object; SAM outlines the object under the pointer.
  - **Box (SAM)**: shift-drag a box around a harder object; SAM segments inside the box.
  - **Circle**: shift-drag a freehand lasso; the lasso polygon itself becomes the example without running SAM.
- How users find matches:
  - **SAM**: uses SAM-embedding similarity to propose matching objects in the current view. Good for visually distinctive, reasonably sized objects that the user can show by example.
  - **Classifier**: trains an in-browser classifier from the examples. Useful when the examples are small, textured, or not well separated by SAM embedding similarity.
  - **SAM->Classifier**: first finds objects with SAM similarity, then trains the classifier on those SAM results plus the user's examples. Use when SAM gets a useful first pass but the classifier may generalize or clean it up.
- Typical workflow: choose the Segment Similar Objects tool, select foreground examples, optionally add background examples for confusing look-alikes, choose the "Find with" mode, tune the similarity threshold and size range, inspect the putative objects, then click Accept to create real annotations.
- Best practices: start with 2-5 clean foreground examples; add background examples when false positives share similar texture; zoom in if objects are tiny; use box prompts for touching objects; use grid/thorough prompts only when normal point prompts miss too many objects because they are slower.
- Important limitations: results are computed for the current viewport, so users can pan/zoom and repeat the process to "roam and accept" across a large image. SAM descriptors are not perfectly scale-invariant, so examples taken at one zoom may match less well after a large zoom change.
- This tool supersedes older "Few-Shot SAM" wording. If the user asks about Few-Shot SAM or Segment Anything with Examples, guide them to Segment Similar Objects.

## Selection & Editing Tools
Refine and manage objects:

**Pointer Tool**:
- Select objects individually
- Shift-click to add to selection

**Lasso Tool**:
- Select multiple objects by drawing around them
- Shift-drag to create selection area

**Blob Edit Tool**:
- Modify existing blob shapes
- Draw a line to slice objects into parts
- Can add or remove areas from blobs

**Combine Annotations**:
- Merge overlapping blob annotations into a single unified polygon
- Use the "Click to combine" action (part of the blob-editing tools): click one blob, then click another, to merge them into one
- Useful for joining adjacent or overlapping segmentation results into one object

## Tool Creation & Configuration
Create custom tools tailored to your workflow:

1. Click "Add new tool" in the Toolset panel
2. Select tool type from the menu
3. Configure settings:
   - Layer: Which image layer to draw on
   - Tag: Label for created objects (key for organization)
   - Name: Custom name for your tool
   - Hotkey: Optional keyboard shortcut

**Advanced Options**:
- Z/time assignment: Place objects on specific slices
- Color override: Custom colors for annotations
- Batch processing: Run automated tools across multiple positions/times

**Tool Management**:
- Edit existing tools with the pencil icon
- Delete tools no longer needed


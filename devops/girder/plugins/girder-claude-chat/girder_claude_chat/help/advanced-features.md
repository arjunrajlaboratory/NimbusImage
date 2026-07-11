# 12. Advanced Features

## Batch Processing
Process multiple images efficiently:

**Automated Tool Batching**:
- Most automated tools support batch processing
- Parameters:
  - Batch XY: Process multiple positions
  - Batch Z: Process multiple Z-slices
  - Batch Time: Process multiple time points
- Format: Range notation like "1-5" or "1-3, 7-9"
- Always test on small subset before full batch

**Batch Computation Across Collections**:
- Run automated annotation tools (like Cellpose-SAM, Piscis, etc.) across multiple datasets in a collection at once
- Up to 50 datasets can be processed in a single batch operation
- This is ideal for applying the same segmentation or detection to all conditions in an experiment
- Select "Apply to datasets in collection" to process multiple datasets with the same settings

**Performance Considerations**:
- Enable tiling for large images (Tile size parameter)
- Set appropriate overlap for object sizes
- Monitor progress in worker status panel
- Consider server resources for extensive batching

## Custom Analysis Workflows
Create specialized analysis pipelines:

**Sequential Analysis**:
- Chain multiple tools and properties
- Example: segment → connect → count → filter → measure
- Create tools with consistent tags for integration
- Use properties as filters for conditional analysis

**Comparative Analysis**:
- Add datasets to collections for consistent analysis
- Apply identical tools across multiple conditions
- Export standardized results for comparison
- Use snapshots to document corresponding regions

**Multi-step Object Definition**:
- Combine automated and manual annotations
- Refine automated results with editing tools
- Use selection filters to isolate subpopulations
- Apply different analyses to different subsets

## Retraining Models
Customize machine learning algorithms for your data:

**Cellpose Training**:
1. Create high-quality manual cell annotations
2. Tag annotations consistently (e.g., "training_cells")
3. Create training regions (optional but recommended)
4. Add Cellpose Training tool from toolset menu
5. Configure parameters:
   - Base model (cyto3, nuclei)
   - Output model name
   - Primary/secondary channels
   - Training tag and region
6. Run training process
7. Use custom model in regular Cellpose tool

**Piscis Training**:
1. Create point annotations for spots
2. Define training regions with consistent tag
3. Add Piscis Train tool from toolset
4. Configure parameters:
   - Initial model name
   - New model name
   - Annotation tag
   - Region tag
5. Run training process
6. Custom model appears in Piscis tool's model list

**Finding Your Custom Models**:
After training completes, your custom model files are stored in special folders in your file system:
- **Cellpose models**: Located in the `.cellpose` folder at the root of your Private or Public directory
- **Piscis models**: Located in the `.piscis` folder at the root of your Private or Public directory
- These folders may be hidden by default in the file browser—look for folders starting with a dot (.)
- Custom models automatically appear in the model dropdown menu when creating new tools

**Training Tips**:
- Quality over quantity: Few perfect annotations beat many poor ones
- Include diverse examples of your structures
- Include difficult cases that default models struggle with
- For difficult datasets, iterative training often helps

## External Tool Integration
Connect NimbusImage with external analysis tools:

**Data Export for External Analysis**:
- Export to CSV for statistical analysis
- Export to JSON for custom processing
- Export images for external image analysis

**Data Import from External Tools**:
- Import annotations via JSON
- Import results back into NimbusImage
- Visualize external analysis in context

**API Access** (for advanced users):
- Connect to backend (Girder) via Python notebooks
- Direct database interaction for custom workflows
- Programmatic control of NimbusImage functions
- Contact support if you are interested in this functionality

**Data Format Conversion**:
- Use external tools for format conversion
- Process OME-TIFFs with `large_image_converter`
- Process IncuCyte data with provided scripts

These advanced features allow experienced users to extend NimbusImage's capabilities, customize analysis for specific research needs, and integrate with broader computational workflows while maintaining the platform's interactive advantage.


# 7. Image Processing Tools

## Overview
NimbusImage offers several image processing tools to enhance and prepare your data for analysis:
- Improve image quality
- Correct for movement or intensity variation
- Focus on specific regions of interest
- Reduce noise

All processing tools create a new processed version while preserving your original data.

## General Workflow
1. Select "ADD NEW TOOL" from the Toolset panel
2. Choose a processing tool (Crop, Registration, etc.)
3. Configure tool parameters
4. Run the worker process
5. Toggle between original and processed versions using the dropdown below the dataset navigator

## Crop Tool
Reduce image dimensions to focus on regions of interest:
- **XY Range**: Keep specific positions (format: "1-3, 5-8")
- **Z Range**: Keep specific Z-slices
- **Time Range**: Keep specific time points
- **Crop Rectangle**: Use an annotation to define crop region

Useful for:
- Removing unnecessary image areas
- Focusing analysis on specific regions
- Reducing dataset size for faster processing

## Registration Tool
Correct for movement in time-lapse sequences by aligning frames to a reference:

**Manual Control Points**:
- Create point annotations that mark the same feature across frames
- Tag these points with a consistent tag (e.g., "registration_points")
- Specify this tag in "Control point tag" parameter
- The tool will use these points to guide alignment

**Automated Registration** (the Algorithm parameter; the default "Translation" is strongly recommended):
- None (control points only): uses only your control points, with no algorithmic alignment
- Translation: Corrects X/Y movement (sliding)
- Rigid: Corrects translation and rotation
- Affine: Corrects translation, rotation, and scaling

**Combined Approach**:
- Use "Apply algorithm after control points" to first align based on manual points, then refine with the selected algorithm
- This hybrid approach often yields best results for challenging datasets

Particularly valuable for:
- Correcting drift in long time-lapse experiments
- Enabling accurate tracking of objects over time
- Handling complex movement patterns

## Histogram Matching
Normalize intensity distributions across images by matching histograms to a reference:
- **Reference image**: Select position, Z-slice, and time point as reference
- **Channel selection**: Choose which channels to normalize

When to use:
- Time-lapse data with photobleaching (intensity decay over time)
- Multi-position acquisitions with varying illumination
- Comparing images acquired with different exposure settings
- Before quantitative intensity measurements across images

The tool preserves relative intensity differences within each image while standardizing overall ranges.

## Gaussian Blur
Apply smoothing to reduce noise using a Gaussian filter:
- **Sigma**: Controls blur strength (0-100) - higher values produce stronger blurring
- **Channel selection**: Apply to specific or all channels

The Gaussian filter creates a weighted average of each pixel's neighborhood, with weights following a bell curve distribution.

Strategic applications:
- Preprocessing step before spot or edge detection
- Noise reduction in low-light images
- Smoothing artifacts before segmentation
- Creating background estimates for subtraction

## Deconvolution (Deconwolf)
Computationally reverse optical blurring in 3D fluorescence microscopy images:
- Uses the Richardson-Lucy algorithm with a theoretically generated Born-Wolf point spread function (PSF)
- Designed for fluorescence microscopy Z-stacks: if the input has only a single Z-slice, deconvolution is not applicable and the image passes through unchanged
- GPU acceleration is enabled by default (automatically falls back to CPU if unavailable)

**Optical Parameters**:
- Numerical Aperture (NA): The NA of the objective used
- Refractive Index: The refractive index of the immersion medium
- Pixel Size XY: The physical pixel size in the XY plane
- Z Step: The distance between Z-slices
- Emission Wavelength: The emission wavelength of the fluorophore
- **Auto-extract from ND2**: Can automatically read optical parameters from .nd2 file metadata

**Processing Parameters**:
- Iterations: Number of Richardson-Lucy iterations (more iterations = sharper but noisier)
- GPU: Enable GPU acceleration for faster processing
- Tile Size and Tile Overlap for processing large images

**When to use**:
- 3D fluorescence microscopy data where optical blur limits resolution
- Before quantitative intensity measurements
- To improve visibility of fine structures like filaments or puncta
- Especially effective for widefield microscopy images

Image processing is typically used as a preparatory step before object detection and analysis, ensuring optimal data quality for downstream quantification.


# 6. Interacting with Objects

## Selection and Manipulation
NimbusImage enables direct interaction with objects in your analysis:
- **Shift-drag** across objects to select multiple objects at once
- Once selected, a popup menu appears with options:
  - **Delete selected** to remove selected objects
  - **Delete unselected** to keep only selected objects
  - **Tag selected** to add or change tags
  - **Color selected** to apply custom colors
  - **Copy selected IDs** to reference object identifiers

This selection tool is particularly useful for cleaning up results from automated segmentation by quickly removing false positives or applying consistent tags to object groups.

## Object Browser and Filtering
The Object Browser provides tools for managing object visibility:
- **Tag filtering** to filter objects by their tags
- **Tag match options** to show objects matching "Any" or "All" selected tags
- **Current frame only** option to display objects in the current time frame
- **Show annotations from hidden layers** toggle to control annotation visibility

## Advanced Filtering
Three powerful filtering mechanisms are available:
1. **Property value filter** for filtering based on measurements (area, intensity, etc.)
2. **Annotation ID filter** to find specific objects by unique IDs
3. **Region filter** to show only objects within a drawn region of interest

These filters can be combined to precisely target objects meeting multiple criteria.

## Annotation List
The Annotation List provides a detailed tabular view of all objects:
- **Customizable columns** for displaying object information
- **Sorting** by clicking any column header
- **Navigation** to objects by clicking rows
- **Bulk actions** for selected objects
- **Pagination** for datasets with many objects

## Working with Properties
Properties allow measurement of object features:
- **View available properties** for each object type
- **Show in list** to display properties in the Annotation List
- **Use as filter** to filter objects based on property values
- **Measure objects** to create new properties

Pressing "t" while viewing an image displays property values directly on the objects, providing in-context visualization of measurements.


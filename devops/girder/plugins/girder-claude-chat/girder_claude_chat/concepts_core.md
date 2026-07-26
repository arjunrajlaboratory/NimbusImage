# NimbusImage core concepts

## Objects
Objects are the fundamental elements you identify in your images for analysis. NimbusImage supports several types:
- **Points**: Represent specific locations like RNA spots or cell centers
- **Blobs**: 2D polygons that outline structures like cells, nuclei, or tissue regions
- **Lines**: Track paths, boundaries, or structures like filaments
- **Rectangles**: Define regions of interest for analysis or processing

Each object has a spatial location, tag(s) for identification, and can have associated properties.

## Connections
Connections establish relationships between objects, creating a network of associations for deeper analysis:
- Connect RNA spots to their containing cells
- Link organelles to their parent structures
- Connect the same cell across time points for tracking
- Establish spatial relationships between different objects

Connections have direction (parent to child) and can be created manually or automatically.

## Properties
Properties are measurements or calculations applied to objects:
- **Intensity measurements**: Mean, max, median fluorescence within objects
- **Geometric measurements**: Area, perimeter, shape metrics
- **Count measurements**: Number of spots per cell, children per parent
- **Distance measurements**: Distance between objects or to nearest object

Properties turn qualitative observations into quantitative data for analysis.

## Tags
Tags are the organizational system that makes NimbusImage flexible:
- Label objects by type (nucleus, cell, RNA spot)
- Group objects by experimental condition
- Categorize objects by feature (dividing, apoptotic)
- Select specific groups for analysis or visualization

Tags enable you to perform targeted analyses on specific object subsets.

## Datasets & Collections
NimbusImage organizes image data hierarchically:
- **Dataset**: A set of related images with their objects, connections, and properties
  - Can be a single file (like an .nd2) or multiple files combined
  - Includes all annotations and analysis data
  - Stored as a folder containing one or more files

- **Collection**: A group of compatible datasets sharing visualization settings
  - Ensures consistent interface across related datasets
  - Allows for coordinated analysis of multiple experiments
  - Datasets can belong to multiple collections
  - Every dataset belongs to at least one collection

This structure allows for efficient data organization and consistent analysis across experiments. For instance, you can collect data for different conditions on different days and then use collections to organize and analyze the data together.


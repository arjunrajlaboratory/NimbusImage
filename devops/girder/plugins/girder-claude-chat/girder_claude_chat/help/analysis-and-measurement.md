# 9. Analysis & Measurement

## Property Workers
Property workers compute quantitative measurements for your objects:

**Creating Properties**:
1. Click "Measure objects" in the top bar
2. Select tag of objects to measure
3. Choose algorithm from dropdown
4. Configure algorithm-specific parameters
5. Click "Create Property" — the "Compute upon creation" checkbox is on by default, so this both creates the property and runs the computation
6. To re-run a property later (or if you unchecked "Compute upon creation"), use "Compute all" in the property list

**Worker Types**:
- Shape-based (areas, perimeters)
- Intensity-based (fluorescence values)
- Count-based (spots per cell)
- Distance-based (object proximities)
- Relationship-based (parent-child connections)

## Intensity Measurements
Quantify fluorescence signals within and around objects:

**Blob Intensity**:
- Measures pixel values within blob objects
- Metrics: Mean, max, min, median, 25th/75th percentiles, total intensity
- Parameter: Channel selection for measurement
- Useful for protein expression levels or staining intensity

**Blob Intensity Percentile**:
- Measures specific percentile of intensity within blobs
- Parameters: Channel and custom percentile value (0-99.99999, default 50)
- Good for customized thresholds or outlier handling

**Blob Annulus Intensity**:
- Measures intensity in a ring around blob objects
- Parameters: Channel and radius of annular region
- Perfect for cytoplasmic measurements around nuclei
- Same metrics as regular intensity (mean, max, etc.)

**Point Intensity**:
- Measures within circular region around point objects
- Parameters: Channel and radius (0.5-10 pixels)
- Useful for spot brightness quantification
- Ideal for RNA FISH or particle analysis

## Geometric Measurements
Analyze object shapes and sizes:

**Blob Metrics**:
- Comprehensive shape analysis of polygon objects
- No additional parameters needed
- Measurements include:
  - Area: Total enclosed space
  - Perimeter: Boundary length
  - Centroid: Geometric center (x,y)
  - Elongation: Shape stretching (0-1)
  - Convexity: Area ratio to convex hull
  - Solidity: Ratio of the object's perimeter to the perimeter of its convex hull
  - Rectangularity: How well the object fits within its minimum bounding rectangle
  - Circularity: How closely object resembles a circle
  - Eccentricity: Deviation from circular shape

**Point Metrics**:
- Extracts x,y coordinates of point objects
- Useful for spatial distribution analysis

## Count Measurements
Enumerate relationships between objects:

**Blob Point Count**:
- Counts points within each blob object
- Parameters:
  - Tags of points to count
  - Count across Z-slices option
  - Exact tag matching toggle
- Ideal for counting spots per cell or nucleus

**Count Children**:
- Counts objects connected to each parent
- Parameters: Child tags and tag exclusivity
- Useful for counting objects outside physical boundaries
- Works with any connection type

## Distance Measurements
Quantify spatial relationships:

**Distance to Nearest Blob**:
- Measures from points to nearest blob
- Parameters:
  - Blob tags to target
  - Distance type (centroid or edge)
  - Option to create connections
- Useful for measuring distances to structural features

**Point to Nearest Point**:
- Measures between point objects
- Parameters:
  - Target point tags
  - Z/Time measurement options
- Good for analyzing spot distributions

**Point to Nearest Connected Point**:
- Similar to above but only for connected objects
- Useful for analyzing relationships in established networks

## Viewing and Filtering Results
Access and interact with your measurements:

**Viewing Properties**:
1. Open "Object list" tab
2. Expand "Properties" dropdown
3. Select property and check specific measurements
4. Values appear in the object list
5. Press "t" to display values directly on image

**Filtering by Properties**:
1. Click "Use as filter" in Properties panel
2. Adjust histogram sliders to set range
3. Only objects within range will be displayed
4. Creates dynamic selections based on measurements

**Exporting Results**:
- Export to CSV: click the Import / export data icon in the top app bar → Export CSV
- Format ready for analysis in Excel, R, Python
- Contains all selected properties and object metadata

The analysis system's flexibility comes from combining these measurement types with the tagging and connection system, allowing for complex, multi-step analyses of your image data.


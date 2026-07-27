# 8. Connections & Relationships

## Manual Connection Tools
Create connections between objects directly with intuitive tools:

**Click Connect**:
- First click selects the "parent" object
- Second click selects the "child" object
- Creates a directed connection from parent to child
- Can be filtered by tag to connect only specific object types
- Useful for precise, individual connections

**Lasso Connect**:
- Draw around multiple objects to connect them
- Objects are connected sequentially based on spatial arrangement
- In time-lapse mode, objects are connected in time order
- Extremely useful for quickly building or repairing tracks
- Ideal for connecting multiple spots to a cell at once

## Automated Connection Tools
Let algorithms establish connections based on criteria:

**Connect to Nearest**:
- Automatically connects objects based on proximity
- Parameters:
  - Parent/child tags: Specify which objects to connect
  - Distance measurement: From centroid or edge
  - Maximum distance: Limit connection range
  - Connection constraints: None, touching, or contained within
  - Connection limit: Connect to N nearest children
- Can operate across Z-slices and time points
- Perfect for associating spots with cells or organelles with nuclei

**Connect Timelapse**:
- Specialized tool for tracking objects across sequential frames
- Parameters:
  - Object tag: Which objects to track
  - Gap handling: Maximum frames an object can disappear
  - Maximum distance: How far objects can move between frames
- Creates parent-child connections from earlier to later frames
- Automatically tags connections as "Time lapse connection"

## Time Lapse Connections
Special considerations for temporal relationships:

**Time Lapse Mode**:
- Enable with checkbox in variable navigation panel
- Visualizes tracks as connected lines between time points
- Line thickness reflects a connection's position relative to the current time point (segments still ahead of the playhead are drawn thicker, those already passed are thinner)
- Skipped frame connections appear in red
- "Track window" controls how many frames to display before/after current time

**Track Visualization**:
- Objects are labeled with time point information (T=1, T=2, etc.)
- Current time point is highlighted
- Click any object in a track to jump to that time point
- Color-coding helps distinguish different tracks

## Managing Connections
Tools and techniques for maintaining connection accuracy:

**Disconnect Tools**:
- **Click Disconnect**: Select parent then child to remove specific connection
- **Lasso Disconnect**: Draw around connected objects to remove all connections in region

**Editing Tracks**:
- Use Lasso Connect to repair broken tracks
- "Orphan" objects (not connected to tracks) often appear gray
- Select across several frames to fix multiple connections at once

**Filtering and Visibility**:
- Toggle connection visibility in Settings → Object display
- Filter connections by tag in the tag picker
- Select objects to highlight their connections

**Connection Analysis**:
- Use "Count children" property to quantify connections
- "Parent and child" property captures relationship data
- Export connection data for lineage or network analysis

Connections transform isolated objects into meaningful relationships, enabling analyses like cell lineage tracking, spatial association, and structural hierarchy.


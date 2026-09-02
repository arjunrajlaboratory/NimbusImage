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
- Enable with the "Time lapse mode" checkbox in the Navigator palette. The checkbox only appears for datasets with more than one time point, and not while time is unrolled
- Turning it on opens a separate **Time Lapse palette** immediately to the right of the Navigator, which holds everything the mode configures. The palette and the mode are the same switch: closing the palette turns time lapse mode off
- Visualizes tracks as connected lines between time points
- Line thickness reflects a connection's position relative to the current time point (segments still ahead of the playhead are drawn thicker, those already passed are thinner)
- Connections that skip a timepoint (a gap in the track) are drawn dashed and semi-transparent, keeping their track's color

**Time Lapse Palette Controls**:
- **Window** (3–100): how many time points of track to draw on either side of the current frame. This was previously called "Track window" and lived in the Navigator
- **Tag picker**: restrict the tracks drawn to objects carrying particular tags
- **Labels**: show or hide the per-object time point labels
- **Coloring** (two-button toggle): the palette icon gives every track its own color; the crossed-out-colors icon draws every track white, which is easier to read when many tracks overlap
- **Shuffle** (shuffle icon): re-rolls the color assignment when two neighbouring tracks happen to land on similar hues. It re-permutes rather than rotating, so a second shuffle cannot land back on the palette you just rejected. Only available under per-track coloring
- **"N tracks · M links"** readout: the dataset-wide count of tracks (connected groups of objects) and of connections. This is the place to look for "how many tracks do I have"
- **Show tracks**: opens the Object list on the Connections tab, grouped by track
- **Delete all timelapse connections**: removes every connection tagged "Time lapse connection". Other connections (Connect to nearest, hand-made ones) are left alone. Undoable with the undo button

**Track Visualization**:
- Objects are labeled with time point information (T=1, T=2, etc.)
- Current time point is highlighted, and its dot is drawn larger
- Click any object in a track to jump to that time point
- Under per-track coloring each track gets its own hue, chosen so that tracks created at the same time still come out visually distinct
- Objects not connected to any track ("orphans") are drawn gray
- Selected objects and selected connections are both drawn in cyan, so one color means "selected" throughout the mode
- While time lapse mode is on, the selection popup menus move to the top right of the viewport so they do not sit underneath the Time Lapse palette

## Track View in the Object List
Open the Object list, choose the **Connections** tab, and group by track (or use "Show tracks" in the Time Lapse palette). Each track gets one collapsible row:

- A **color swatch** matching the color that track is drawn in, so a line picked out in the viewer can be matched to its row
- **Track \<id\>**, followed by the object count, the time range it spans (T1–T12), and the link count. The link count is the diagnostic one: it exceeds (objects − 1) only when a track branches or carries duplicate links
- **Clicking the row** expands it to show the individual connections *and* frames the track in the viewport — the camera centers on the track and zooms so it occupies about a fifth of the view, keeping the surrounding cells visible for context. It moves XY and Z to the track member nearest the current frame. What it does to the time point depends on the mode: in time lapse mode a whole window of frames is drawn, so it only nudges the time point when the current frame falls outside the track's range; with the mode off only one frame is drawn, so it snaps to the nearest member of the track, otherwise you would be looking at an empty region. Collapsing the row leaves the camera where it is
- **Select ▾** menu, with three choices:
  - **Objects (N)**: selects the track's objects, feeding actions like "Connect selected", "Tag selected" and "Color selected". Endpoints whose object no longer exists are excluded from both the selection and the count
  - **Links (M)**: selects the track's connections, feeding "Delete selected"
  - **Both**: selects each side at once, which is usually what reviewing a track wants
  Objects and links are separate selections feeding separate actions, so choosing one deliberately leaves the other alone. Each choice replaces its own selection rather than adding to it — use the per-row checkboxes to build up a union across tracks
- **Delete track**: removes every connection in the track in one batched operation. The objects themselves are kept

**Track ID labels from a property**: by default track rows are titled with a short internal id. If a track ID property has been computed (e.g. the **Parent-Child Connection IDs** worker, which stores a `trackId` per object), pick it in the **Track ID property** select and each row is titled `Track 42` using that value — matching the ids in exported CSVs, so a track flagged in post-processing can be found in the panel. Warning badges flag staleness: `partial` means some members were added after the property was computed, `mixed IDs` means tracks were joined afterwards, `no ID` means no member has a value. Re-running the property refreshes the ids. The chosen property is saved with the collection.

## Filtering Connections by Track Metrics
The Connections tab has a **Track filters** menu (filter icon) with optional min/max bounds on three dataset-wide track metrics:

- **Connections in track** — number of links
- **Objects in track** — number of members
- **Duration in timepoints** — the time span the track covers

A connection whose track falls outside any active bound is hidden from the list **and** from the viewer (both normal connection lines and timelapse tracks). The count readout becomes "N of M" while narrowing, and the filter button shows a badge. Notes:

- Metrics are dataset-wide: a track judged by these bounds is the full track, even if the list is currently scoped to a subset
- **"Also hide these tracks' objects in the image"** (off by default) extends the filter to the filtered-out tracks' objects in the viewer. It is a display lens only — the Objects tab, exports and analysis are untouched, and objects with no connections are never hidden. While active it registers in the coverage HUD as an active constraint
- Track filters are session-only view state, reset when switching datasets — if tracks seem missing, check this menu
- Bulk delete respects the filter: only listed connections are deleted

## Cleaning Up Dangling Connections
When connections point at deleted objects (e.g. objects removed after tracking), the Connections tab shows a cleanup row with the live count, offering a whole-dataset batched delete behind a confirm dialog. It participates in undo and is hidden entirely on healthy datasets. Under an active duration bound, tracks whose every endpoint is deleted are excluded as unknowable — cleanup is the remedy.

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


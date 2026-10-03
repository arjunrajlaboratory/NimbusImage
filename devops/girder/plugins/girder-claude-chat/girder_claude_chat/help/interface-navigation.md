## Navigating the Interface
After loading your data, navigate the interface:
- **Home Page**: Tabbed interface with "Recent Datasets", "Recent Projects", and (when sample data is configured) "Sample Datasets"
- **Top Bar**: Buttons that open floating palettes — Navigator, Layers, Tools, 3D view, Object list, Filters, Analysis, Snapshots, Settings, and Measure objects, plus a magnifier button that opens the command palette (see below). (Connections are managed inside the Object list, not a separate top-bar tab.)
- **Time Lapse palette**: has no top-bar button. It appears to the right of the Navigator when "Time lapse mode" is checked in the Navigator, and closing it turns the mode back off
- **Center**: The main image viewing area fills the window; palettes open over it
- **Floating panels**: These palettes float over the viewport as semi-transparent glass overlays (you can still see the image through them) rather than pushing it aside, and they stay open while you interact with the image

Press `tab` anytime to see available keyboard shortcuts.

## Command Palette (⌘K / Ctrl+K)
Press ⌘K (Mac) or Ctrl+K (Windows/Linux), or click the magnifier button in the top bar, to open a search box over everything the viewer can do. It works even while typing in a text field. Type a few words and press Enter (arrow keys move, Esc closes):
- **Tools**: "Use tool: Nuclei" selects a tool (its hotkey is shown on the right)
- **Add tool**: "Add tool: Cellpose-SAM…" opens tool creation with that type pre-selected — it never adds a tool without showing you the settings
- **Panels**: "Open Filters", "Close Layers"
- **Layers**: "Toggle layer: DAPI"
- **Snapshots**: "Go to snapshot: Fig 2"
- **Properties**: "Color by: Area" opens the Color-by dialog with that property chosen
- **Actions and Help**: Measure, Undo/Redo, import/export dialogs, Pipelines, Suggest tools, 3D view, Upload, the AI panel, docs, and guided tours

Matching is forgiving: initials ("cs" for Cellpose-SAM), partial words, tool descriptions and a few domain synonyms (spots/puncta, cells/nuclei, measure/property) all work. With an empty search box, the palette shows your recently used commands followed by a sample from each group. The list updates itself as tools, layers, snapshots and workers change. Outside a dataset view, only general commands appear (home, upload, the AI panel, tours, help).

## Basic Image Viewing & Manipulation
Essential controls for viewing your images:

**Navigation**:
- **Zoom**: Mouse wheel or pinch gesture
- **Pan**: Click and drag in the main view
- **Minimap**: Use the small overview (top right by default, draggable to any corner) to navigate quickly — drag within it to move, or shift-click-drag to jump directly to a location
- **Variable Navigation**: Sliders to move through XY, Z, and time dimensions
- **Label Display**: Toggle between text/name labels (e.g., "Well A1", "1 second") and numeric identifiers in the Viewer Settings

**Display**:
- **Contrast**: Click the palette icon to adjust intensity ranges
- **Layers**: Turn channels on/off with the toggle buttons
- **Color**: Change channel colors in the layer settings
- **Scale Bar**: Click to adjust units and appearance

**View Options**:
- **Unroll**: View multiple positions or channels as a montage
- **Layer Grouping**: Combine channels into custom groups
- **Annotations**: Toggle visibility with the `a` key


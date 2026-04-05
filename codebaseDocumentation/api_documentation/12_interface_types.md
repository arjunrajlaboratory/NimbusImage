# Worker Interface Types

## Overview

Every worker defines an `interface()` function that describes the UI parameters shown to users. The interface dict is sent to the server via `UPennContrastWorkerPreviewClient.setWorkerImageInterface()`.

## Interface Definition

```python
def interface(image, apiUrl, token):
    client = workers.UPennContrastWorkerPreviewClient(apiUrl=apiUrl, token=token)

    interface = {
        'Parameter Name': {
            'type': 'number',          # Required: the widget type
            'default': 10,             # Optional: default value
            'required': True,          # Optional: whether field is required
            'tooltip': 'Help text',    # Optional: tooltip on hover
            'displayOrder': 1,         # Optional: sort order in the UI
            # ... type-specific attributes
        }
    }

    client.setWorkerImageInterface(image, interface)
```

## Type Reference

### `number`

Numeric input with optional min/max/unit.

```python
'Diameter': {
    'type': 'number',
    'min': 0,
    'max': 200,
    'default': 10,
    'unit': 'pixels',
    'displayOrder': 7,
}
```

**Returns in `params['workerInterface']`**: `int` or `float`
```python
diameter = float(workerInterface['Diameter'])  # 10.0
```

### `text`

Free-form text input.

```python
'Batch XY': {
    'type': 'text',
    'vueAttrs': {
        'placeholder': 'ex. 1-3, 5-8',
        'label': 'Enter the XY positions',
        'persistentPlaceholder': True,
        'filled': True,
    },
    'displayOrder': 1,
}
```

**Returns**: `str` (can be empty string `""`)
```python
batch_xy = workerInterface.get('Batch XY', None)
# Returns: "1-3, 5-8" or "" or None
```

### `select`

Dropdown selection from a list of options.

```python
'Model': {
    'type': 'select',
    'items': ['cyto', 'cyto2', 'cyto3', 'nuclei'],
    'default': 'cyto3',
    'noCache': True,  # Re-fetch options each time (for dynamic lists)
    'displayOrder': 4,
}
```

**Returns**: `str`
```python
model = workerInterface['Model']  # "cyto3"
```

### `checkbox`

Boolean toggle.

```python
'Use physical units': {
    'type': 'checkbox',
    'value': False,  # Note: uses 'value' not 'default'
    'displayOrder': 1,
}
```

**Returns**: `bool`
```python
use_physical = workerInterface.get('Use physical units', False)  # True or False
```

### `channel`

Channel selector dropdown (populated from the image's channel list).

```python
'Channel': {
    'type': 'channel',
    'required': True,
    'displayOrder': 1,
}
'Secondary Channel': {
    'type': 'channel',
    'default': -1,   # -1 means "none"
    'required': False,
    'displayOrder': 2,
}
```

**Returns**: `int` (channel index, or -1 for "none")
```python
channel = workerInterface['Channel']  # 0
secondary = workerInterface.get('Secondary Channel', -1)  # -1
```

### `channelCheckboxes`

Multi-select checkboxes for channels.

```python
'Channels to correct': {
    'type': 'channelCheckboxes',
    'displayOrder': 2,
}
```

**Returns**: `dict` of `str` → `bool` (string channel indices!)
```python
allChannels = workerInterface['Channels to correct']
# {'0': True, '1': True, '2': False}

# Convert to int channel indices:
channels = [int(k) for k, v in allChannels.items() if v]  # [0, 1]
```

### `tags`

Tag selector (multi-select from existing tags in the dataset).

```python
'Training Tag': {
    'type': 'tags',
    'displayOrder': 5,
}
```

**Returns**: `list` of `str` (NOT a dict!)
```python
tags = workerInterface.get('Training Tag', [])
# ["DAPI blob"]

# WRONG — will crash:
# tags = workerInterface.get('Training Tag', {}).get('tags', [])
```

### `layer`

Layer selector.

```python
'Reference Layer': {
    'type': 'layer',
    'displayOrder': 3,
}
```

**Returns**: `str` (layer ID)

### `notes`

Display-only HTML text (not an input).

```python
'Cellpose': {
    'type': 'notes',
    'value': 'This tool runs the Cellpose model. '
             '<a href="https://docs.nimbusimage.com/..." target="_blank">Learn more</a>',
    'displayOrder': 0,
}
```

**Returns**: Nothing — this is display-only.

## Common Interface Attributes

| Attribute | Purpose |
|-----------|---------|
| `type` | Widget type (required) |
| `default` | Default value |
| `value` | Used for `checkbox` and `notes` types |
| `required` | Whether the field must be filled |
| `tooltip` | Hover help text (supports `\n` for line breaks) |
| `displayOrder` | Sort order in the UI (lower = higher) |
| `items` | Options for `select` type |
| `min`, `max` | Range for `number` type |
| `unit` | Display unit for `number` type |
| `noCache` | Re-fetch options on each open (for dynamic `select` lists) |
| `vueAttrs` | Pass-through Vue component attributes (for `text` type) |

## The `params` Dict (Compute Function)

When a worker's `compute` function runs, `params` contains:

```python
{
    'configurationId': '...',
    'datasetId': '...',
    'description': 'tool description',
    'type': 'tool type',
    'id': 'property/tool id',
    'name': 'tool name',
    'image': 'docker/image:tag',
    'channel': 0,                                    # Selected channel
    'assignment': {'XY': 0, 'Z': 0, 'Time': 0},     # Assignment position
    'tags': ['output_tag'],                           # For annotation workers: plain list
    # OR for property workers:
    'tags': {'tags': ['filter_tag'], 'exclusive': False},
    'tile': {'XY': 0, 'Z': 0, 'Time': 0},            # Current tile position
    'connectTo': {'tags': ['nucleus'], 'channel': 0}, # Connection config
    'workerInterface': {                               # User-supplied interface values
        'Diameter': 10,
        'Model': 'cyto3',
        'Batch XY': '1-3',
        # ...
    },
    'scales': {                                        # Physical scale info
        'pixelSize': {'unit': 'mm', 'value': 0.000219},
        'tStep': {'unit': 's', 'value': 1},
        'zStep': {'unit': 'm', 'value': 1}
    },
    'annotationIds': ['...'],                          # For property workers: specific annotations
}
```

**Key difference**: `params['tags']` is a plain `list` for annotation workers but a `dict` with `{'tags': [...], 'exclusive': bool}` for property workers.

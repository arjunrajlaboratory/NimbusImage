# Worker Messaging

**Source**: `annotation_client/utils.py`

Workers communicate with the NimbusImage frontend via JSON messages printed to stdout. The job runner captures these and forwards them to the UI.

## Functions

### sendProgress

```python
from annotation_client.utils import sendProgress

sendProgress(0.5, 'Computing', 'Processing frame 50/100')
```

Outputs: `{"progress": 0.5, "title": "Computing", "info": "Processing frame 50/100"}`

- `progress`: float between 0 and 1 for the progress bar
- `title`: bold text in the progress display
- `info`: secondary text after the title

### sendWarning

```python
from annotation_client.utils import sendWarning

sendWarning('No objects found', title='Warning', info='Check your tags and shape filters.')
```

Outputs: `{"warning": "No objects found", "title": "Warning", "info": "Check...", "type": "warning"}`

Used for non-fatal issues (invalid polygons, out-of-range Z planes, etc.).

### sendError

```python
from annotation_client.utils import sendError

sendError('No primary channel selected', title='Error', info='Please select a channel.')
```

Outputs: `{"error": "No primary channel selected", "title": "Error", "info": "Please...", "type": "error"}`

Used for fatal issues that prevent computation.

## Rate-Limited Progress

For large annotation lists, sending a progress message per annotation floods the server. Use the helper:

```python
from annotation_utilities.progress import update_progress

for i, annotation in enumerate(annotations):
    # ... process ...
    update_progress(i + 1, len(annotations), "Computing intensity")
```

This only sends a message every 1% for collections >100 items.

## Manual Rate Limiting

Some workers implement their own rate limiting:

```python
number_annotations = len(annotationList)
if number_annotations > 100:
    if i % int(number_annotations / 100) == 0:
        sendProgress((i+1)/number_annotations, 'Processing', f"{i+1}/{number_annotations}")
else:
    sendProgress((i+1)/number_annotations, 'Processing', f"{i+1}/{number_annotations}")
```

# Usage Patterns from Workers and Notebooks

## Pattern 1: Annotation Worker with WorkerClient (Cellpose, Piscis)

The simplest pattern for ML annotation workers. WorkerClient handles all the iteration and annotation creation.

```python
import annotation_client.workers as workers
from worker_client import WorkerClient
from functools import partial

def interface(image, apiUrl, token):
    client = workers.UPennContrastWorkerPreviewClient(apiUrl=apiUrl, token=token)
    interface = {
        'Model': {'type': 'select', 'items': ['cyto3', 'nuclei'], 'default': 'cyto3'},
        'Diameter': {'type': 'number', 'min': 0, 'max': 200, 'default': 10},
        'Primary Channel': {'type': 'channel', 'required': False},
        'Batch XY': {'type': 'text', 'vueAttrs': {'placeholder': 'ex. 1-3, 5-8'}},
        'Batch Z': {'type': 'text', 'vueAttrs': {'placeholder': 'ex. 1-3, 5-8'}},
        'Batch Time': {'type': 'text', 'vueAttrs': {'placeholder': 'ex. 1-3, 5-8'}},
    }
    client.setWorkerImageInterface(image, interface)

def compute(datasetId, apiUrl, token, params):
    worker = WorkerClient(datasetId, apiUrl, token, params)

    model = load_model(worker.workerInterface['Model'])
    diameter = float(worker.workerInterface['Diameter'])
    channel = worker.workerInterface.get('Primary Channel', worker.channel)

    def process(image):
        return model.predict(image, diameter=diameter)

    worker.process(process, f_annotation='polygon', stack_channels=[channel])
```

**Used by**: cellpose, cellposesam, piscis, random_squares, sample_interface

## Pattern 2: Property Worker (Blob Intensity, Blob Metrics)

Property workers compute measurements on existing annotations.

```python
import annotation_client.workers as workers
import annotation_client.tiles as tiles
import annotation_utilities.annotation_tools as annotation_tools
from annotation_utilities.progress import update_progress
from collections import defaultdict

def compute(datasetId, apiUrl, token, params):
    workerClient = workers.UPennContrastWorkerClient(datasetId, apiUrl, token, params)
    datasetClient = tiles.UPennContrastDataset(apiUrl=apiUrl, token=token, datasetId=datasetId)

    channel = params['workerInterface']['Channel']

    # Get and filter annotations
    annotationList = workerClient.get_annotation_list_by_shape('polygon', limit=0)
    annotationList = annotation_tools.get_annotations_with_tags(
        annotationList,
        params.get('tags', {}).get('tags', []),
        params.get('tags', {}).get('exclusive', False)
    )

    # Group by location for efficient image loading
    grouped = defaultdict(list)
    for ann in annotationList:
        key = (ann['location']['Time'], ann['location']['Z'], ann['location']['XY'])
        grouped[key].append(ann)

    property_value_dict = {}
    processed = 0
    for (time, z, xy), anns in grouped.items():
        frame = datasetClient.coordinatesToFrameIndex(xy, z, time, channel)
        image = datasetClient.getRegion(datasetId, frame=frame)

        for ann in anns:
            # Compute properties...
            property_value_dict[ann['_id']] = {'MeanIntensity': value, ...}
            processed += 1
            update_progress(processed, len(annotationList), "Computing")

    workerClient.add_multiple_annotation_property_values({datasetId: property_value_dict})
```

**Used by**: blob_intensity, blob_metrics, point_circle_intensity, point_to_nearest_point_distance, blob_random_forest_classifier

## Pattern 3: Image Processing Worker (Histogram Matching, Registration)

Workers that create new images from existing ones.

```python
import annotation_client.tiles as tiles
import large_image as li

def compute(datasetId, apiUrl, token, params):
    tileClient = tiles.UPennContrastDataset(apiUrl=apiUrl, token=token, datasetId=datasetId)

    sink = li.new()
    for i, frame in enumerate(tileClient.tiles['frames']):
        large_image_params = {f'{k.lower()[5:]}': v for k, v in frame.items()
                              if k.startswith('Index') and len(k) > 5}

        image = tileClient.getRegion(datasetId, frame=i).squeeze()
        processed = process(image)
        sink.addTile(processed, 0, 0, **large_image_params)

    # Copy metadata
    if 'channels' in tileClient.tiles:
        sink.channelNames = tileClient.tiles['channels']
    sink.mm_x = tileClient.tiles['mm_x']
    sink.mm_y = tileClient.tiles['mm_y']
    sink.magnification = tileClient.tiles['magnification']

    sink.write('/tmp/output.tiff')
    gc = tileClient.client
    item = gc.uploadFileToFolder(datasetId, '/tmp/output.tiff')
    gc.addMetadataToItem(item['itemId'], {'tool': 'MyTool'})
```

**Used by**: histogram_matching, registration, deconwolf

## Pattern 4: Connection Worker (Connect to Nearest, Connect Timelapse)

Workers that create relationships between annotations.

```python
import annotation_client.annotations as annotations
import annotation_utilities.annotation_tools as annotation_tools

def compute(datasetId, apiUrl, token, params):
    annotationClient = annotations.UPennContrastAnnotationClient(apiUrl=apiUrl, token=token)

    all_points = annotationClient.getAnnotationsByDatasetId(datasetId, shape='point', limit=10000000)
    all_blobs = annotationClient.getAnnotationsByDatasetId(datasetId, shape='polygon', limit=10000000)

    parents = annotation_tools.get_annotations_with_tags(all_blobs, parent_tags)
    children = annotation_tools.get_annotations_with_tags(all_points, child_tags)

    connections = []
    for child in children:
        nearest_parent = find_nearest(child, parents)
        connections.append({
            'datasetId': datasetId,
            'parentId': nearest_parent['_id'],
            'childId': child['_id'],
            'tags': combined_tags
        })

    annotationClient.createMultipleConnections(connections)
```

**Used by**: connect_to_nearest, connect_timelapse, sam2_propagate

## Pattern 5: Direct Annotation Creation (Stardist, SAM2)

Workers that create annotations without using WorkerClient batch mode.

```python
import annotation_client.annotations as annotations
import annotation_client.tiles as tiles

def compute(datasetId, apiUrl, token, params):
    annotationClient = annotations.UPennContrastAnnotationClient(apiUrl=apiUrl, token=token)
    tileClient = tiles.UPennContrastDataset(apiUrl=apiUrl, token=token, datasetId=datasetId)

    tile = params['tile']
    channel = params['channel']

    frame = tileClient.coordinatesToFrameIndex(tile['XY'], tile['Z'], tile['Time'], channel)
    image = tileClient.getRegion(datasetId, frame=frame).squeeze()

    polygons = detect_objects(image)

    out_annotations = []
    for polygon in polygons:
        out_annotations.append({
            'tags': params.get('tags', []),
            'shape': 'polygon',
            'channel': channel,
            'location': {'XY': tile['XY'], 'Z': tile['Z'], 'Time': tile['Time']},
            'datasetId': datasetId,
            'coordinates': [{'x': float(x), 'y': float(y)} for x, y in polygon.exterior.coords],
        })

    annotationClient.createMultipleAnnotations(out_annotations)
```

**Used by**: stardist, sam2_propagate, sam2_refine

## Pattern 6: Composite RGB from Layer Settings (SAM Workers)

SAM/SAM2 workers need an RGB image matching the user's view (with contrast + pseudocolor). This is a distinct pattern from single-channel access.

```python
import annotation_client.tiles as tiles
import annotation_client.annotations as annotations
import annotation_utilities.annotation_tools as annotation_tools
import numpy as np

def ensure_rgb(image):
    """Ensure image is (H, W, 3) uint8 RGB."""
    if image.ndim == 2:
        image = np.stack([image, image, image], axis=-1)
    elif image.ndim == 3 and image.shape[2] == 1:
        image = np.repeat(image, 3, axis=2)
    elif image.ndim == 3 and image.shape[2] == 4:
        image = image[:, :, :3]
    if image.dtype in (np.float32, np.float64):
        if image.max() <= 1.0 and image.min() >= 0.0:
            image = (image * 255).astype(np.uint8)
        else:
            image = np.clip(image, 0, 255).astype(np.uint8)
    return image

def compute(datasetId, apiUrl, token, params):
    tileClient = tiles.UPennContrastDataset(apiUrl=apiUrl, token=token, datasetId=datasetId)
    annotationClient = annotations.UPennContrastAnnotationClient(apiUrl=apiUrl, token=token)

    # Get layer settings ONCE (doesn't change per location)
    layers = annotation_tools.get_layers(tileClient.client, datasetId)

    # For each location that needs processing...
    for XY, Z, Time in locations:
        # Load all channels at this location
        images = annotation_tools.get_images_for_all_channels(tileClient, datasetId, XY, Z, Time)

        # Merge with contrast + pseudocolor settings
        merged_image = annotation_tools.process_and_merge_channels(images, layers)

        # Convert for the model
        image = merged_image.astype(np.float32)   # SAM2
        # or
        image = ensure_rgb(merged_image)           # SAM1 (uint8 RGB)

        # Feed to predictor
        predictor.set_image(image)
        # ... run inference, create annotations ...
```

**Key insight**: `get_layers` reads the user's saved contrast/color configuration from Girder. Without it, raw fluorescence data (uint16) would be unusable by RGB vision models. The merged image reproduces exactly what the user sees in the NimbusImage UI.

**Used by**: sam2_propagate, sam2_refine, sam2_automatic_mask_generator, sam2_fewshot_segmentation, sam_fewshot_segmentation

## Pattern 7: Interactive Notebook Usage (from sandbox notebooks)

```python
import girder_client
import annotation_client.annotations as annotations
import annotation_client.tiles as tiles
import numpy as np
from shapely.geometry import Polygon
from skimage import draw
import matplotlib.pyplot as plt

# Connect
apiUrl = 'http://localhost:8080/api/v1'
client = girder_client.GirderClient(apiUrl=apiUrl)
user_id = client.authenticate(username='arjunraj', password='xyz123')['_id']
annotationClient = annotations.UPennContrastAnnotationClient(apiUrl=apiUrl, token=client.token)

# List datasets
datasets = {}
for folder in annotationClient.client.listFolder(user_id, 'user'):
    for dataset in annotationClient.client.listFolder(folder['_id']):
        datasets[dataset['name']] = dataset['_id']

# Open a dataset
datasetId = datasets['my_dataset']
tileClient = tiles.UPennContrastDataset(apiUrl=apiUrl, token=client.token, datasetId=datasetId)

# Get an image
frame = tileClient.coordinatesToFrameIndex(xy=0, z=0, time=0, channel=0)
image = tileClient.getRegion(datasetId, frame=frame).squeeze()
plt.imshow(image)

# Get annotations
all_annotations = annotationClient.getAnnotationsByDatasetId(datasetId, shape='polygon', limit=1000000)

# Compute intensity for an annotation
annotation = all_annotations[0]
polygon = np.array([[c['y'] - 0.5, c['x'] - 0.5] for c in annotation['coordinates']])
rr, cc = draw.polygon(polygon[:, 0], polygon[:, 1], shape=image.shape)
mean_intensity = np.mean(image[rr, cc])

# Load multiple time points for registration
images = []
for t in range(4):
    frame = tileClient.coordinatesToFrameIndex(0, 0, t, 0)
    images.append(tileClient.getRegion(datasetId, frame=frame).squeeze())
```

## Pattern 7: Morphological Operations on Annotations

From notebooks — expanding polygons, creating annular masks:

```python
from shapely.geometry import Polygon
from skimage import draw, morphology

annotation = annotations[0]
polygon = np.array([[c['y'] - 0.5, c['x'] - 0.5] for c in annotation['coordinates']])

# Create mask from polygon
shapely_poly = Polygon(polygon)
mask = draw.polygon2mask(image.shape, polygon).squeeze()

# Create annular mask (ring around the polygon)
disk_radius = 5
dilated_mask = morphology.binary_dilation(mask, morphology.disk(disk_radius))
annulus_mask = dilated_mask & ~mask

# Or using shapely buffer
dilated_poly = shapely_poly.buffer(5)
dilated_mask = draw.polygon2mask(image.shape, np.array(dilated_poly.exterior.coords)).squeeze()
annulus_mask = dilated_mask & ~mask

# Compute intensities in the annulus
annulus_intensities = image[annulus_mask]
```

---
description: >
  Run Docker-based computational workers on NimbusImage datasets using the
  nimbusimage Python API. Use this skill when the user wants to run
  segmentation, spot detection, property computation, or any Docker worker
  on their imaging data. Also use when you see ds.annotations.compute or
  ds.properties.compute in code, or the user mentions running workers,
  submitting jobs, tracking job status, or automating image analysis pipelines
  on a NimbusImage server.
---

# NimbusImage — Workers

Workers are Docker containers that perform computations on datasets — segmentation, spot detection, measurements, image processing. They run server-side via Girder Worker and are tracked as jobs.

There are two kinds of workers:
- **Annotation workers** — create annotations (points, polygons) on image data
- **Property workers** — compute measurement values for existing annotations

## Discovering workers

```python
import nimbusimage as ni

client = ni.connect()

# List all available worker images on the server
workers = client.list_workers()
for image, labels in workers.items():
    is_ann = labels.get("isAnnotationWorker") == "true"
    is_prop = labels.get("isPropertyWorker") == "true"
    print(f"{image}: {labels.get('interfaceName', '')} "
          f"[ann={is_ann}, prop={is_prop}]")

# Get the parameter interface for a specific worker
interface = client.get_worker_interface("annotations/random_squares:latest")
for param_name, spec in interface.items():
    print(f"  {param_name}: type={spec['type']}, default={spec.get('default', '')}")
```

Worker labels include:
- `isAnnotationWorker` / `isPropertyWorker` — what kind of worker it is
- `interfaceName` — display name
- `description` — what it does
- `annotationShape` — shape it produces (point, polygon, etc.)

## Running annotation workers

```python
ds = client.dataset("dataset_id")

# Submit a worker job
job = ds.annotations.compute(
    image="annotations/random_squares:latest",
    channel=0,
    tags=["detected"],
    worker_interface={
        "Number of squares": 100,
        "Square size": 15,
    },
)

# Wait for completion (prints progress to stderr)
success = job.wait()
print(f"Job {'succeeded' if success else 'failed'}")
```

### With auto-connection

When an annotation worker creates new annotations, you can auto-connect them to existing nearest neighbors:

```python
job = ds.annotations.compute(
    image="annotations/laplacian_of_gaussian:latest",
    channel=0,
    tags=["spots"],
    worker_interface={"Sigma": 2.0},
    connect_to={"tags": ["nucleus"], "channel": 0},
)
job.wait()
```

The `connect_to` dict must always include a `tags` key (use `{"tags": []}` for no connections). Omitting it causes a KeyError in the worker.

### Specifying location and assignment

```python
# Process a specific tile
job = ds.annotations.compute(
    image="annotations/my_worker:latest",
    channel=0,
    tags=["result"],
    location=ni.Location(xy=0, z=3, time=0),
    worker_interface={"threshold": 0.5},
)

# Process a range of tiles (batch)
job = ds.annotations.compute(
    image="annotations/my_worker:latest",
    channel=0,
    tags=["result"],
    assignment={"XY": "0-2", "Z": 0, "Time": "0-4"},
    worker_interface={"threshold": 0.5},
)
```

### Full parameter reference

```python
job = ds.annotations.compute(
    image="docker/image:tag",   # Docker image name (required)
    channel=0,                   # Channel index (default: 0)
    tags=["tag1", "tag2"],       # Tags for created annotations
    location=ni.Location(...),   # Single tile location
    assignment={...},            # Batch range (overrides location)
    worker_interface={...},      # Worker-specific parameters
    scales={...},                # Pixel size metadata
    connect_to={                 # Auto-connect settings
        "tags": ["parent_tag"],
        "channel": 0,
    },
    name="my job",               # Job display name
)
```

## Running property workers

Property workers compute measurement values for existing annotations:

```python
# Step 1: Create (or find) a property definition
prop = ds.properties.get_or_create("Blob Intensity", shape="polygon")

# Step 2: Register the property with the dataset's collection
ds.properties.register(prop.id)

# Step 3: Run the property worker
job = ds.properties.compute(
    prop,
    worker_interface={"Channel": 0},
    scales=ds.collections.get_raw().get("meta", {}).get("scales", {}),
)
job.wait()

# Step 4: Fetch the computed values
values = ds.properties.get_values()
```

## Job tracking

The `Job` object tracks worker execution:

```python
# Blocking wait (prints progress)
success = job.wait()          # returns True/False
success = job.wait(timeout=300)  # with 5-minute timeout

# Non-blocking polling
while not job.finished:
    job.refresh()
    print(f"Status: {job.status_name}")
    time.sleep(5)

# Job properties
job.status        # int: 0=inactive, 1=queued, 2=running, 3=success, 4=error, 5=cancelled
job.status_name   # str: "inactive", "queued", "running", "success", "error", "cancelled"
job.finished      # bool: True if status >= 3
job.log           # str: job log output
```

Status codes: 0=inactive, 1=queued, 2=running, **3=success**, 4=error, 5=cancelled. Note: status 3 is SUCCESS, not "still running" — easy to confuse.

## Writing your own worker

Workers are Docker containers that receive parameters and use the `nimbusimage` API to read/write data:

```python
# Inside a Docker worker script
import nimbusimage as ni

ctx = ni.worker_context()  # reads env vars set by Girder Worker
ds = ctx.dataset
params = ctx.params

# Access worker parameters
threshold = params.get("workerInterface", {}).get("threshold", 0.5)
channel = params.get("channel", 0)

# Read image data
img = ds.images.get(channel=channel, z=0, time=0)

# Create annotations from results
detections = my_detection_algorithm(img, threshold=threshold)
annotations = [
    ni.Annotation.from_point(x=x, y=y, channel=channel,
                              tags=params.get("tags", []),
                              dataset_id=ds.id)
    for x, y in detections
]
ds.annotations.create_many(annotations)
```

Install with worker extras: `pip install nimbusimage[worker]`

## Common patterns

### Run a pipeline: detect then measure

```python
# Step 1: Run detection worker
job = ds.annotations.compute(
    image="annotations/laplacian_of_gaussian:latest",
    channel=0,
    tags=["spots"],
    worker_interface={"Sigma": 2.0},
)
job.wait()

# Step 2: Run property worker on the detected annotations
prop = ds.properties.get_or_create("Spot Intensity", shape="point")
ds.properties.register(prop.id)
job = ds.properties.compute(prop, worker_interface={"Channel": 0})
job.wait()

# Step 3: Get results
values = ds.properties.get_values()
```

## Important notes

- Worker parameter keys must match the interface exactly (e.g., `"Square size"` not `"square_size"`). Check with `client.get_worker_interface()`.
- The `connect_to` dict must always include `"tags"` — use `{"tags": []}` for no connections.
- Property workers require the property to be created and registered before running.
- `job.wait()` blocks the Python process. For long-running workers, consider non-blocking polling.

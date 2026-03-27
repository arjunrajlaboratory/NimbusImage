---
description: >
  Connect to a NimbusImage server and work with scientific imaging datasets
  using the nimbusimage Python API. Use this skill whenever the user mentions
  NimbusImage, wants to connect to a Girder-based imaging server, list or open
  datasets, or asks about the nimbusimage package. Also use when you see
  `import nimbusimage` in code or the user references dataset IDs, channels,
  z-slices, or time points in an imaging context. This is the entry point —
  it routes to more specific skills (annotations, images, workers, analyze)
  for deeper operations.
---

# NimbusImage — Core

The `nimbusimage` Python API lets you programmatically access NimbusImage scientific imaging datasets. This skill teaches you the API patterns so you can write correct code for the user.

The package follows an accessor pattern: connect → get dataset → use sub-accessors (`ds.images`, `ds.annotations`, `ds.connections`, `ds.properties`, `ds.collections`, `ds.export`, `ds.history`, `ds.sharing`).

## Setup

The package must be installed first:

```bash
pip install nimbusimage
```

For Docker worker development (includes `large_image` for writing TIFF files):

```bash
pip install nimbusimage[worker]
```

## Connecting

**Before writing any connection code, check whether the user already has credentials configured.** Follow this sequence:

1. Check if `NI_API_URL` and `NI_API_KEY` (or `NI_TOKEN`) environment variables are set (run `echo $NI_API_URL` etc.)
2. If both are set, use `ni.connect()` with no arguments — it reads them automatically
3. If not set, **ask the user** for their server URL and API key
4. If they don't have an API key, tell them to request one from their NimbusImage administrator
5. Suggest they set env vars for future sessions so credentials aren't repeated

Never hardcode credentials in scripts. Never guess default passwords. If the user provides credentials in conversation, use them for the current session but remind them that env vars are more secure for repeated use.

```python
import nimbusimage as ni

# Best: environment variables (NI_API_URL + NI_API_KEY) — just works
client = ni.connect()

# With explicit API key
client = ni.connect("http://localhost:8080/api/v1", api_key="your-api-key")

# With session token (expires — API key is preferred)
client = ni.connect("http://localhost:8080/api/v1", token="session-token")

# With username/password (for one-off interactive use)
client = ni.connect("http://localhost:8080/api/v1", username="...", password="...")
```

### Setting up environment variables (recommend to users)

The recommended setup uses an **API key**, which is persistent and doesn't expire (unlike session tokens).

**How to get an API key:**

- **nimbusimage.com (hosted):** Email **support@cytopixel.com** with your account email address to request an API key.
- **Local/self-hosted server:** In the Girder admin UI, go to **Users** > select the user > **Edit User** > **API Keys** > create a new key and copy the key string.

```bash
# Add to ~/.zshrc or ~/.bashrc for persistence

# For nimbusimage.com:
export NI_API_URL="https://app.nimbusimage.com/girder/api/v1"
export NI_API_KEY="your-api-key-here"

# For a local server:
export NI_API_URL="http://localhost:8080/api/v1"
export NI_API_KEY="your-api-key-here"

# Optional: frontend URL for browser links
export NI_FRONTEND_URL="http://localhost:5173"
```

### Authentication priority

The package tries auth methods in this order:
1. Explicit `token=` parameter
2. Explicit `api_key=` parameter
3. Explicit `username=` / `password=` parameters
4. `NI_API_KEY` environment variable (recommended)
5. `NI_TOKEN` environment variable (session token, expires)

| Variable | Description |
|----------|-------------|
| `NI_API_URL` | Girder API URL (e.g., `http://localhost:8080/api/v1`) |
| `NI_API_KEY` | Girder API key (persistent, recommended) |
| `NI_TOKEN` | Session token (expires, use API key instead) |
| `NI_FRONTEND_URL` | Frontend URL for browser links (default: `http://localhost:5173`) |

## Dataset discovery

```python
# List all accessible datasets
datasets = client.list_datasets()
for d in datasets:
    print(f"{d['name']} (ID: {d['_id']})")

# Get a dataset by ID
ds = client.dataset("64a1b2c3d4e5f6a7b8c9d0e1")

# Or look it up by name
ds = client.dataset(name="My Experiment")
```

## Dataset metadata

```python
print(f"Name: {ds.name}")
print(f"Shape: {ds.shape}")          # (height, width)
print(f"Channels: {ds.channels}")    # list of channel names
print(f"Num channels: {ds.num_channels}")
print(f"Z-slices: {ds.num_z}")
print(f"Time points: {ds.num_time}")
print(f"XY positions: {ds.num_xy}")
print(f"Pixel size: {ds.pixel_size.to('um').value} um")
print(f"Dtype: {ds.dtype}")
print(f"Magnification: {ds.magnification}")

# Iterate all frames
for frame in ds.frames:
    print(f"Frame {frame.index}: ch={frame.channel}, z={frame.z}, t={frame.time}")
```

## Opening in browser

```python
# Open dataset viewer in browser
ds.open(z=3, time=0)

# Get URLs without opening
print(ds.view_url())           # Image viewer URL
print(ds.info_url())           # Dataset info page
print(ds.configuration_url())  # Configuration page
```

## Projects

```python
projects = client.list_projects()
project = client.project(project_id)
new_project = client.create_project("My Project", description="...")
project.open()  # Open in browser
```

## Workers (discovery)

```python
# List all available worker Docker images
workers = client.list_workers()
for image, labels in workers.items():
    print(f"{image}: {labels.get('interfaceName', '')}")

# Get a worker's parameter interface
interface = client.get_worker_interface("annotations/random_squares:latest")
for param, spec in interface.items():
    print(f"  {param}: type={spec['type']}, default={spec.get('default', '')}")
```

## Data models

All models are Pydantic BaseModel with `to_dict()` and `from_dict()`:

- `ni.Annotation` — shape, tags, channel, location, coordinates
- `ni.Connection` — parent_id, child_id, tags
- `ni.Property` — name, shape, image (Docker), worker_interface
- `ni.Location` — xy, z, time
- `ni.PixelSize` — value, unit (with `.to('um')` conversion)
- `ni.FrameInfo` — index, xy, z, time, channel, channel_name
- `ni.Job` — status, wait(), refresh(), log

## Routing to other skills

For deeper operations, route to the appropriate skill:

- **`/nimbusimage:images`** — fetching image frames, composites, z-stacks, crops
- **`/nimbusimage:annotations`** — creating, listing, filtering, deleting annotations; geometry helpers
- **`/nimbusimage:workers`** — running annotation and property workers, job tracking
- **`/nimbusimage:analyze`** — properties, export, connections, sharing

For the full API reference for any accessor, read the corresponding reference file in the `references/` directory.

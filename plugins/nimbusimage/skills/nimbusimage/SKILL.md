---
name: nimbusimage
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

### Install troubleshooting

Two snags come up often enough that they belong here:

- **`error: externally-managed-environment` (PEP 668).** Homebrew Python on macOS and most distro Pythons on Linux refuse `pip install` into the system interpreter. Use a venv:

  ```bash
  python3 -m venv ~/venvs/ni
  source ~/venvs/ni/bin/activate
  pip install nimbusimage
  ```

- **Phantom namespace package in the NimbusImage source repo.** The repo at `arjunrajlaboratory/NimbusImage` contains a top-level `nimbusimage/` directory (the source of the package). If you run Python from the repo root, PEP 420 namespace-package resolution will let `import nimbusimage` "succeed" with an empty module **even when nothing is installed**, so the usual `python -c "import nimbusimage"` smoke test is misleading. Verify with `__file__`:

  ```python
  import nimbusimage
  assert nimbusimage.__file__, "nimbusimage is shadowed by a local directory"
  print(nimbusimage.__file__)  # should point inside a site-packages dir
  ```

  If `__file__` is `None`, either `pip install nimbusimage` into a venv, or `cd` out of the NimbusImage repo before running your script.

## Connecting

**Before writing any connection code, check whether the user already has credentials configured.** Follow this sequence:

1. Check whether the variables are set without printing their values:

   ```bash
   test -n "${NI_API_URL:-}" && echo "NI_API_URL is set" || echo "NI_API_URL is missing"
   test -n "${NI_API_KEY:-}" && echo "NI_API_KEY is set" || echo "NI_API_KEY is missing"
   test -n "${NI_TOKEN:-}" && echo "NI_TOKEN is set" || echo "NI_TOKEN is missing"
   ```

2. If `NI_API_URL` and either credential variable are set, use `ni.connect()` with no arguments.
3. If credentials are missing, tell the user which variables to export in their local shell, then rerun the presence check. Do not ask them to paste API keys, tokens, or passwords into the conversation.
4. If they do not have an API key, tell them to request one from their NimbusImage administrator.

Never print, hardcode, or repeat credentials. Never guess default passwords.

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

## Creating a dataset from image files

Uploading files does not by itself make a dataset — the files are just items in
a folder until they are **configured** into one multi-dimensional image. Three
steps:

```python
ds = client.create_dataset("My Experiment")   # empty; goes in your Private folder
ds.upload("path/to/images/")                  # a file, a directory, or a list
ds.configure()                                # works out XY / Z / Time / Channel
ds.open()                                     # opens it in the browser
```

`upload()` is not recursive and raises if the directory contains
subdirectories, so a partial upload can't be mistaken for a complete one.

`configure()` is the API equivalent of the web UI's configuration screen: it
derives the dimensions from filename tokens and file metadata, writes the
multi-source configuration, and (unless every file is `.nd2`) schedules a
transcode job.

### Always dry-run first

`configure(dry_run=True)` computes everything and writes nothing. Do this
before a real run — when the configuration is not valid, a real run **raises**,
and the exception does not carry the variable list you need to fix it:

```python
plan = ds.configure(dry_run=True)
if not plan.is_valid:
    print(plan.validation_error)        # e.g. "Not all variables are assigned"
    for v in plan.unassigned_variables:
        print(v["name"], v["source"], v["guess"], v["size"])
```

The common case is more variables than the four dimensions' defaults fill —
typically a filename variable left over once file metadata has claimed Z and C.
Assign it by copying the variable's `source`/`guess` onto the dimension you
want:

```python
# dry run reported: Filename variable 1 (source='filename', guess='C', size=2)
result = ds.configure(
    assignments={"XY": {"source": "filename", "guess": "C"}},
    transcode=False,
)
print(result.item_id, result.job_id)
```

Each `assignments` entry is `{"source", "guess"}` or `None` (leave the
dimension unassigned); omitted dimensions keep their default. `source` is one
of `filename`, `file` (embedded metadata such as ND2 IndexRange), or `images`
(raw frame order).

### Other options and failures

| Argument | Meaning |
|---|---|
| `transcode` | Convert to one tiled TIFF. Omit to use the UI's rule (on unless every file is `.nd2`); pass `False` to skip. |
| `split_rgb_bands` | Split an RGB image into three channels (default `True`). |
| `enable_compositing` | Lay out a single multi-position ND2 by stage coordinates rather than as separate XY positions. Only applies to a single source with ND2 frame metadata — read `result.compositing` for what actually happened, and expect XY to collapse to one position when it does. |
| `create_view` | Also create the collection and dataset view the web UI needs (default `True`). Turn it off only if you are going to create your own. |

Failures come back as `girder_client.HttpError`: 400 for an invalid
configuration — unassigned variables, **sources with different pixel types**
(every file must share a `dtype`), an item with zero or several files, and
filenames whose parts do not line up (`a.tif` alongside `b_x_0.tif`: the web UI
cannot configure that folder either) — and 409
if the dataset is already configured. Reconfiguring means starting from a new
dataset.

When `transcode` is on, `configure()` returns as soon as the job is **queued**,
so checking it is your job — and a failure is not self-healing:

```python
result = ds.configure()
if result.job_id and not client.job(result.job_id).wait():
    # The dataset is configured but its image is unusable. Configuring
    # again raises 409 because the configuration item exists; delete
    # result.item_id, or start from a new dataset.
    ...
```

### Opening it in the UI

`configure()` creates a collection and dataset view by default, so the dataset
behaves like one made through the web UI — it appears in
`client.list_datasets()` (which enumerates views) and opens straight away:

```python
result = ds.configure()
print(result.collection_id, result.view_id)
ds.open()            # opens the viewer in a browser
print(ds.view_url()) # or just the URL
```

The collection gets the same defaults the UI would create: one layer per
channel (up to six), named after the channel and coloured from the shared
channel-colour table, with percentile contrast, plus pixel size from the tile
metadata and z-step inferred from the dimension labels.

With `create_view=False` none of that is created. The dataset is still fully
readable through the API (`ds.channels`, `ds.images`, annotations), but
`ds.open()` and `ds.view_url()` raise `No dataset view found`, and
`client.list_datasets()` will not list it.

### One thing this does not do

- **Caches are not warmed.** The web UI additionally precomputes tile frames,
  max-merge and histograms after configuring, so the first open of an
  API-created dataset is slower than one made through the UI.

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

- **Images skill** — fetching image frames, composites, z-stacks, crops
- **Annotations skill** — creating, listing, filtering, deleting annotations; geometry helpers
- **Workers skill** — running annotation and property workers, job tracking
- **Analyze skill** — properties, export, connections, sharing

For full accessor signatures, read `references/api-overview.md`. Before using lower-level APIs or modifying access, read `references/gotchas.md`.

## Safety: stay on the accessor layer

The accessors (`ds.images`, `ds.annotations`, `ds.sharing`, etc.) are the supported surface. `client._gc` is the raw `girder-client` and exposes every Girder endpoint, including ones that can do irreversible damage if used wrong. Specifically:

- **Never** call `client._gc.put(f"folder/{ds.id}/access", ...)` to change a dataset's ACL. Use `ds.sharing.share()` / `ds.sharing.set_public()` — they call the incremental `dataset_view/share` endpoint and can't accidentally lock the owner out. The raw endpoint replaces the whole ACL and has been the source of an in-the-wild lockout. See `references/gotchas.md` for the full list of `_gc` footguns.
- If an accessor doesn't expose what you need, ask the user before reaching for `_gc`. The accessor surface is curated for a reason; adding to it is preferable to bypassing it.

# nimbusimage

Python API for [NimbusImage](https://nimbusimage.com) ([app](https://app.nimbusimage.com)) — programmatic access to scientific imaging datasets, annotations, workers, and analysis.

## Installation

```bash
pip install nimbusimage
```

For Docker worker development (includes `large_image` for writing TIFF files):

```bash
pip install nimbusimage[worker]
```

## Authentication

The recommended setup uses a **Girder API key**, which is persistent and doesn't expire.

**How to get an API key:**

- **nimbusimage.com (hosted):** Email **[support@cytopixel.com](mailto:support@cytopixel.com)** with your account email address to request an API key.
- **Local/self-hosted server:** In the Girder admin UI, go to **Users** > select the user > **Edit User** > **API Keys** > create a new key and copy the key string.

Set environment variables for persistent access:

```bash
# Add to ~/.zshrc or ~/.bashrc

# For nimbusimage.com:
export NI_API_URL="https://app.nimbusimage.com/girder/api/v1"
export NI_API_KEY="your-api-key-here"

# For a local server:
export NI_API_URL="http://localhost:8080/api/v1"
export NI_API_KEY="your-api-key-here"
```

Then connect with no arguments:

```python
import nimbusimage as ni

client = ni.connect()
```

Or pass credentials explicitly:

```python
client = ni.connect("http://localhost:8080/api/v1", api_key="your-api-key")
```

## Quick start

```python
import nimbusimage as ni

client = ni.connect()

# List datasets
for d in client.list_datasets():
    print(f"{d['name']} (ID: {d['_id']})")

# Open a dataset
ds = client.dataset(name="My Experiment")
print(f"{ds.name}: {ds.channels}, {ds.num_z} z-slices, {ds.shape}")

# Fetch an image
img = ds.images.get(channel=0, z=0)  # numpy array

# Get a composite RGB image
rgb = ds.images.get_composite(dtype="uint8")

# List annotations
polygons = ds.annotations.list(shape="polygon")

# Run a worker
job = ds.annotations.compute(
    image="annotations/random_squares:latest",
    channel=0, tags=["detected"],
    worker_interface={"Number of squares": 10, "Square size": 15},
)
job.wait()

# Export data
ds.export.to_csv(property_paths=[["prop_id", "Area"]], path="results.csv")

# Open in browser
ds.open(z=3)
```

## API overview

The package follows an accessor pattern:

```
ni.connect() -> NimbusClient
    client.dataset(id) -> Dataset
        ds.images        # fetch frames, composites, z-stacks
        ds.annotations   # create, list, filter, delete annotations
        ds.connections   # parent-child annotation links
        ds.properties    # computed measurements
        ds.collections   # display configuration (layers, tools)
        ds.export        # JSON and CSV export
        ds.history       # undo/redo
        ds.sharing       # access control
    client.list_datasets()
    client.list_workers()
    client.list_projects()
```

See [docs.nimbusimage.com](https://docs.nimbusimage.com) for general documentation and the [API reference](https://arjunrajlaboratory.github.io/NimbusImage/) for detailed API docs.

## Claude Code integration

NimbusImage includes skills for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) that teach Claude how to use this API. After installing, you can ask Claude things like "connect to my NimbusImage server and list datasets" and it will write correct code.

### Install the skills

**Option A — Marketplace install (recommended):**

```bash
# Add the NimbusImage marketplace (one-time)
claude plugin marketplace add arjunrajlaboratory/NimbusImage

# Install the nimbusimage plugin
claude plugin install nimbusimage@arjunrajlaboratory/NimbusImage
```

**Option B — For this session only:**

```bash
claude --plugin-dir /path/to/NimbusImage/plugins/nimbusimage
```

**Option C — Permanent (project-scoped):**

Add to your project's `.claude/settings.local.json`:

```json
{
  "plugins": ["/path/to/NimbusImage/plugins/nimbusimage"]
}
```

### Available skills


| Command                    | What it covers                                     |
| -------------------------- | -------------------------------------------------- |
| `/nimbusimage`             | Connection, dataset discovery, metadata, projects  |
| `/nimbusimage:annotations` | Annotation CRUD, geometry helpers, bulk operations |
| `/nimbusimage:images`      | Frame retrieval, composites, z-stacks, crops       |
| `/nimbusimage:workers`     | Docker worker discovery, execution, job tracking   |
| `/nimbusimage:analyze`     | Properties, export, connections, sharing           |


The skills use progressive disclosure — Claude loads only what it needs for the current task.

## Development

```bash
cd nimbusimage
python3 -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"

# Run unit tests (no backend required)
pytest tests/ --ignore=tests/integration -v

# Run integration tests (requires docker compose up)
pytest tests/integration/ -v -m integration
```

## License

See the project root for license information.
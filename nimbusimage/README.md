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

**Required scopes.** The simplest option is a **full-access key** (leave the scope list empty), which works for everything including polling job status. If you instead create a *scoped* key, it must include **`core.user_auth`** — without it, `job.wait()` / `job.refresh()` fail with a confusing `401 Unauthorized` even though you own the job. Add **`jobs.rest.list_job`** as well so job logs can be read. Recommended scoped-key set: `core.data.read`, `core.data.write`, `core.data.own`, `core.user_info.read`, `core.user_auth`, `jobs.rest.list_job`.

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

## Agent integration: Claude Code and Codex

NimbusImage includes a shared set of Agent Skills that teach Claude Code and Codex how to use this API. After installing the plugin, ask either agent to connect to a NimbusImage server, inspect datasets, retrieve images, manage annotations, run workers, or export results.

### Claude Code

```bash
# Add the NimbusImage marketplace (one-time)
claude plugin marketplace add arjunrajlaboratory/NimbusImage

# Install the plugin
claude plugin install nimbusimage@NimbusImage
```

For development from a local clone, load the plugin for one session:

```bash
claude --plugin-dir /path/to/NimbusImage/plugins/nimbusimage
```

### Codex

```bash
# Add the NimbusImage marketplace (one-time)
codex plugin marketplace add arjunrajlaboratory/NimbusImage

# Install the plugin
codex plugin add nimbusimage@NimbusImage
```

When working inside a clone of this repository, Codex can also discover the synchronized repository-local skills under `.agents/skills/` without installing the plugin.

### Available skills

| Skill | Claude Code | Codex | What it covers |
|-------|-------------|-------|----------------|
| Core | `/nimbus-skills:nimbusimage` | `$nimbusimage:nimbusimage` | Connection, dataset discovery, metadata, projects |
| Annotations | `/nimbus-skills:annotations` | `$nimbusimage:annotations` | CRUD, geometry helpers, bulk operations |
| Images | `/nimbus-skills:images` | `$nimbusimage:images` | Frame retrieval, composites, z-stacks, crops |
| Workers | `/nimbus-skills:workers` | `$nimbusimage:workers` | Docker worker discovery, execution, job tracking |
| Analyze | `/nimbus-skills:analyze` | `$nimbusimage:analyze` | Properties, export, connections, sharing |

The skills use progressive disclosure, so each agent loads detailed instructions and API references only when needed. See the [plugin documentation](../plugins/nimbusimage/README.md) for repository-local Codex aliases and skill-development instructions.

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

## Spatial-transcriptomics table (`ds.spatial`)

Datasets served by the `upenncontrast_spatial` plugin hold their full per-cell
expression matrix as one `spatial.zarr.zip` item (AnnData layout; rows join to cell
annotations through `obs.annotation_id`).

```python
ds.spatial.info()                       # None when no table is registered
ds.spatial.upload_and_register("spatial.zarr.zip")
ds.spatial.features("cd", limit=10)     # [{symbol, featureType}]
ds.spatial.column("CD3E")               # {annotationIds, values} non-zero
ds.spatial.row(annotation_id)           # {symbol: value}
ds.spatial.aggregate(["CD3E"], filters={"tags": {"values": ["B Cell"], "exclusive": False}})
ds.spatial.materialize(["CD3E", "MS4A1"], property_name="Gene Expression")
```

`aggregate` takes the same filter object the Objects tab uses (analysis gates included);
`materialize` writes dense sub-values into a property and waits for the server job on
large tables.

Any gene is also usable as a virtual property path, `ds.spatial.virtual_path("CD3E")` →
`["spatial", "CD3E"]`, wherever a property path is accepted (filters, gates, color-by,
list columns, summary). `ds.spatial.score(symbols, name, method="mean")` writes a
gene-set score; `ds.spatial.differential(filters_a, filters_b=None, max_features=50)`
returns the ranked table (Welch t by default, ``method="wilcoxon"`` for Mann-Whitney U)
from a server job.

